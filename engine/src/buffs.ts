/**
 * Buffs and debuffs by track frame.
 *
 * The effects layer says WHAT an effect grants and WHAT triggers it; the
 * simulation says what happened at each step. This module brings the two
 * together: for each frame, which effect rows are up, on whom, and with how
 * many stacks. There is no text parsing here: triggers are already parsed in
 * `data/endfield/effects`.
 *
 * Model decisions — each either measured or named as an assumption:
 *
 * * **A step's trigger takes effect from the next step.** The hit that
 *   applied a debuff does not get it: Breach is not amplified by its own
 *   debuff, the next hit is (measurements, #23).
 * * **One instance per buff.** Team buffs and target debuffs are keyed by
 *   effect id, not by wearer: Eternal Xiranite from two wearers is one buff,
 *   and the second only refreshes the duration (#29). Self buffs are keyed
 *   by wearer.
 * * **Stacks expire individually** ("Duration of each stack is counted
 *   separately" — as almost every stacking effect says); past the cap the
 *   oldest drops out.
 * * **`controlled` rows fire only for the controlled operator**, by the
 *   simulation's `Frame.controlled` at the triggering step.
 * * What a training dummy lacks: `damage_taken` and `hp_restored` never
 *   trigger; `hp_above:N` counts as met (full HP); `crit` is not tracked.
 *   All of this goes into `notes` rather than silently to zero.
 */

import { formatMessage, type Message } from './messages.js';

import type { SkillType } from './bundle.js';
import type { Effect, EffectApply } from './effects.js';
import { timerEnd, type Frame, type TargetState } from './simulate.js';
import { INFLICTION_ELEMENTS, inflictionElement, VULNERABILITY_BUILDERS, VULNERABILITY_CONSUMERS } from './status.js';

/** An effect holder: a squad operator and everything enabled on their build. */
export interface BuffHolder {
  key: string;
  active: Effect[];
  /** The holder's crit rate without track buffs: what `crit` triggers expect per hit. */
  critRate?: number;
}

/**
 * Crit-capable hits a holder lands at a frame — skill hits and the instant
 * hits of statuses she applied; DoT does not crit. With it, `crit` triggers
 * are tracked as an expectation: each hit adds the crit rate, and a stack
 * comes when the running sum crosses a whole number (measurements, #57:
 * a stack per critting hit, Crush included). Without it they stay untracked.
 */
export type CritHits = (frameIndex: number, holder: string) => number;

/** An effect row that is up in a frame. */
export interface ActiveBuff {
  effect: Effect;
  apply: EffectApply;
  /** Who carries the effect. */
  source: string;
  /** Whom it buffs: an operator key, or `enemy` for a target debuff. */
  receiver: string;
  stacks: number;
  /** Value fraction: with `teamShare` the others get a part. */
  scale: number;
  /** World time when the last stack expires; absent — held by target state. */
  until?: number;
}

export interface BuffTimeline {
  /** Per frame: what is up at the START of the step. Aligned with `frames`. */
  frames: ActiveBuff[][];
  /**
   * Per frame: what is up AFTER this step's triggers. The step's statuses
   * are computed with it: Pogranichnik's Breach already hits with Thermite
   * +8 %, switched on by the same cast's SP refund (measurements, #23).
   */
  after: ActiveBuff[][];
  /** Assumptions and what the model does not track. Shown next to the damage. */
  notes: Message[];
  /** `extra_hit` rows that fired: an instance at that frame, by its holder (Swordmancer). */
  extraHits: ExtraHit[];
}

export interface ExtraHit {
  frameIndex: number;
  by: string;
  name: string;
  /** Fraction of ATK. */
  multiplier: number;
  element: string;
}

const KIND_TO_SKILL: Record<string, SkillType> = {
  BA: 'Basic Attack',
  FS: 'Basic Attack',
  FIN: 'Basic Attack',
  DIVE: 'Basic Attack',
  BS: 'Battle Skill',
  CS: 'Combo Skill',
  ULT: 'Ultimate',
};

/** Synonyms from effect texts: "applies Vulnerability" is a Vulnerable stack. */
const ALIASES: Record<string, string> = {
  Vulnerability: 'Vulnerable',
  'Originium Crystals': 'Originium Crystal',
  // Set texts: «applies Amp, Protection, Susceptibility, or Weakness».
  Protection: 'Protect',
  Weakness: 'Weaken',
};

/** A term as the engine spells it: effect triggers say «Originium Crystals», the target holds «Originium Crystal». */
export function canonicalTerm(term: string): string {
  return ALIASES[term] ?? term;
}

/**
 * Whether an applied term matches a trigger term.
 *
 * "Amp" catches "Arts Amp" and "Cryo Amp" — an elemental Amp is an Amp too
 * (#29); "Susceptibility" catches "Physical Susceptibility"; the generic
 * "Arts Infliction" and "Physical Status" catch any of their kinds.
 */
export function termMatches(term: string, wanted: string): boolean {
  const want = ALIASES[wanted] ?? wanted;
  if (term === want) return true;
  if (term.endsWith(` ${want}`)) return true;
  if (want === 'Arts Infliction') return inflictionElement(term) !== null;
  if (want === 'Physical Status') return VULNERABILITY_BUILDERS.has(term) || VULNERABILITY_CONSUMERS.has(term);
  return false;
}

/** What the target has: debuff terms, stacks, stagger. */
function targetHas(target: TargetState | undefined, wanted: string, now = -Infinity): boolean {
  if (!target) return false;
  if (wanted === 'Staggered') return target.staggered;
  const want = ALIASES[wanted] ?? wanted;
  if (want === 'Vulnerable') return target.vulnerable > 0;
  if (want === 'Arts Infliction') return INFLICTION_ELEMENTS.some((element) => target.inflictions[element] > 0);
  const element = inflictionElement(want);
  if (element) return target.inflictions[element] > 0;
  // The target comes from the step before: a debuff that ran out since — the
  // seal during a pause (measurements, #61) — is no longer there.
  return target.debuffs.some((debuff) => termMatches(debuff.term, want) && (debuff.expiresAt == null || debuff.expiresAt > now + 1e-9));
}

/** Terms the step applied on the holder's behalf: applications and statuses. */
function appliedBy(frame: Frame, holder: string): string[] {
  const out = frame.applied.filter((item) => item.by === holder).map((item) => item.term);
  for (const event of frame.status) {
    if (event.by !== holder || event.kind === 'umbrella') continue;
    // Taking a debuff off or spending Link is not applying it.
    if (event.kind === 'debuffConsumed' || event.kind === 'reactionConsumed' || event.kind === 'buffSpent') continue;
    out.push(event.term);
    // A stack on top of a standing one is a Burst of that element: Deep
    // Rampart triggers on "applies Nature Burst".
    if (event.burst && event.element) out.push(`${event.element} Burst`, 'Arts Burst');
  }
  // The first Physical Status on a clean target is Vulnerable instead of
  // itself: Chen's Lift on a fresh boss set off no Swordmancer hit, but did
  // count as applying Vulnerability for Glorious Memory (measurements, #60).
  for (const event of frame.status) {
    if (event.by !== holder || !event.appliedVulnerableInstead) continue;
    for (let left = 2; left > 0; left -= 1) {
      const at = out.indexOf(event.term);
      if (at >= 0) out.splice(at, 1);
    }
    out.push('Vulnerable');
  }
  return out;
}

/** What the step consumed on the holder's behalf. */
function consumedBy(frame: Frame, holder: string): string[] {
  return frame.status
    .filter(
      (event) =>
        event.by === holder &&
        (event.kind === 'consumesInfliction' ||
          event.kind === 'consumesVulnerable' ||
          event.kind === 'debuffConsumed' ||
          event.kind === 'reactionConsumed') &&
        (event.consumed ?? 0) > 0,
    )
    .flatMap((event) => (event.kind === 'consumesVulnerable' ? [event.term, 'Vulnerable'] : [event.term]));
}

/** A trigger with an override from a potential (`modifies`): Pogranichnik's P3 threshold is 60. */
interface Line {
  effect: Effect;
  apply: EffectApply;
  index: number;
  source: string;
  trigger: string;
  max: number;
  /** `target: spender` — whose step set it off: the instance is theirs. */
  spender?: string;
}

function linesOf(holder: BuffHolder): Line[] {
  const out: Line[] = [];
  for (const effect of holder.active) {
    effect.apply.forEach((apply, index) => {
      if (apply.trigger == null && apply.stacks == null) return;
      // SP returned on a trigger is a resource: the simulation pays it
      // (`spOnConsume`, `spOnCast`), and it is no buff with a duration.
      if (apply.stat === 'sp_return') return;
      let trigger = apply.trigger ?? '';
      let max = apply.stacks?.max ?? 1;
      let edited = apply;
      // A potential edits another effect: «Talent The Living Banner improved:
      // … Max Fervent Morale stacks on self +2». `modifies.effect` names the
      // talent (the rows of that effect); a buff name reaches every row that
      // puts the buff up, including another talent's (Tactical Instruction
      // gives Fervent Morale to the spender), so it is only a fallback.
      for (const other of holder.active) {
        const mod = other.modifies;
        if (!mod) continue;
        const named = holder.active.some((item) => item.source.name === mod.effect);
        if (named ? effect.source.name !== mod.effect : apply.name !== mod.effect) continue;
        if (mod.stacksMax) max += mod.stacksMax;
        if (mod.trigger) trigger = mod.trigger;
        if (mod.valueDelta) edited = { ...edited, value: edited.value + mod.valueDelta };
        if (mod.teamShare != null) edited = { ...edited, teamShare: mod.teamShare };
      }
      out.push({ effect, apply: edited, index, source: holder.key, trigger, max });
    });
  }
  return out;
}

function receiversOf(line: Line, team: string[]): Array<{ receiver: string; scale: number }> {
  const { apply, source } = line;
  switch (apply.target) {
    case 'enemy':
      return [{ receiver: 'enemy', scale: 1 }];
    case 'team':
      return team.map((receiver) => ({ receiver, scale: 1 }));
    case 'others':
      return team.filter((key) => key !== source).map((receiver) => ({ receiver, scale: 1 }));
    case 'spender':
      return line.spender ? [{ receiver: line.spender, scale: 1 }] : [];
    default: {
      const share = apply.teamShare;
      if (share == null) return [{ receiver: source, scale: 1 }];
      return team.map((receiver) => ({ receiver, scale: receiver === source ? 1 : share }));
    }
  }
}

/** Instance key: by id for team effects, also by holder for own ones. */
function instanceKey(line: Line): string {
  const shared = line.apply.target !== 'self' || line.apply.teamShare != null;
  const spender = line.spender ? `>${line.spender}` : '';
  return `${line.effect.id}#${line.index}${shared ? '' : `@${line.source}`}${spender}`;
}

/**
 * Buffs by frame.
 *
 * `holders` is the squad with enabled effects (what `activeEffects` gave on
 * each build). Key order is squad order.
 */
export function trackBuffs(frames: Frame[], holders: BuffHolder[], critHits?: CritHits): BuffTimeline {
  const team = holders.map((holder) => holder.key);
  // Deduplicated by their English text: one note per effect and reason.
  const notes = new Map<string, Message>();
  const note = (message: Message): void => {
    notes.set(formatMessage(message), message);
  };
  const lines = holders.flatMap(linesOf).filter((line) => {
    if (line.trigger !== '') return true;
    note({ code: 'buffNoTrigger', effect: line.effect.source.name });
    return false;
  });

  /** Instance → row and stack expiry times. */
  const live = new Map<string, { line: Line; expires: number[] }>();
  /** Recovered SP accumulated per holder — for `sp_recovered:N`. */
  const recovered = new Map<string, number>();
  /** `extra_hit` rows: when each may fire again, and what fired. */
  const readyAt = new Map<string, number>();
  const extraHits: ExtraHit[] = [];
  /** Expected crits accumulated per holder — for `crit`; added once per frame. */
  const crits = new Map<string, { total: number; added: number }>();
  const critRate = new Map(holders.map((holder) => [holder.key, Math.min(1, Math.max(0, holder.critRate ?? 0))]));

  const out: ActiveBuff[][] = [];
  const after: ActiveBuff[][] = [];
  let previous: TargetState | undefined;

  for (const [frameIndex, frame] of frames.entries()) {
    const now = frame.world;
    if (critHits) {
      for (const key of team) {
        const added = critHits(frameIndex, key) * (critRate.get(key) ?? 0);
        const entry = crits.get(key) ?? { total: 0, added: 0 };
        crits.set(key, { total: entry.total + added, added });
      }
    }

    // 1. What is up at the start of the step: drop the expired; target
    //    states come from the frame before this step.
    for (const [key, instance] of live) {
      instance.expires = instance.expires.filter((until) => until > now + 1e-9);
      if (instance.expires.length === 0) live.delete(key);
    }

    /** Live instances and target states, as a list per receiver. */
    const snapshot = (target: TargetState | undefined): ActiveBuff[] => {
      const active: ActiveBuff[] = [];
      const push = (line: Line, stacks: number, until?: number): void => {
        for (const { receiver, scale } of receiversOf(line, team)) {
          active.push({
            effect: line.effect,
            apply: line.apply,
            source: line.source,
            receiver,
            stacks,
            scale,
            ...(until != null && Number.isFinite(until) ? { until } : {}),
          });
        }
      };
      for (const instance of live.values()) {
        push(instance.line, Math.min(instance.expires.length, instance.line.max), Math.max(...instance.expires));
      }
      for (const line of lines) {
        for (const alternative of line.trigger.split('|')) {
          const [kind, arg] = splitTrigger(alternative);
          if (kind === 'target_has' && arg && targetHas(target, arg, now)) {
            push(line, 1);
            break;
          }
          if (kind === 'hp_above') {
            note({ code: 'buffAssumed', effect: line.effect.source.name, condition: alternative });
            push(line, 1);
            break;
          }
        }
      }
      return active;
    };
    out.push(snapshot(previous));

    // "Next cast" buffs are spent by this cast — after it has received
    // them, its statuses included: Grand Vision's +57.6 % was in the Crush
    // of the battle skill that spent it (measurements, #61).
    const spentKeys: string[] = [];
    for (const [key, instance] of live) {
      const spent = instance.line.apply.spentBy;
      if (spent && frame.step.actor === instance.line.source && castMatches(spent, frame)) spentKeys.push(key);
    }

    // 2. What this step switched on: effective from the next step.
    // By whose skill, not whose step: Steel Oath recovers Pogranichnik's SP on a teammate's step.
    for (const [key, sp] of Object.entries(frame.spRecoveredBy)) recovered.set(key, (recovered.get(key) ?? 0) + sp);

    for (const template of lines) {
      const fired = timesFired(template, frame, previous, recovered, note, critHits ? crits : null);
      if (fired === 0) continue;
      // A `spender` buff is the instance of whoever's step this is.
      const actor = frame.step.actor;
      if (template.apply.target === 'spender' && !actor) continue;
      const line: Line = template.apply.target === 'spender' && actor ? { ...template, spender: actor } : template;
      const key = instanceKey(line);
      // A row with its own cooldown fires at most once per `cooldown`
      // seconds: Swordmancer's extra hit, Mi Fu's P3 «each time the shield
      // is triggered» (45 s apart).
      if (line.apply.cooldown != null) {
        if ((readyAt.get(key) ?? -Infinity) > now + 1e-9) continue;
        readyAt.set(key, now + line.apply.cooldown);
      }
      // An instance, not a buff: fires at this step if off cooldown.
      if (line.apply.stat === 'extra_hit') {
        extraHits.push({
          frameIndex,
          by: line.source,
          name: line.apply.name ?? line.effect.source.name,
          multiplier: line.apply.value,
          element: line.apply.element ?? 'Physical',
        });
        continue;
      }
      // From the start of the step — the same way the simulation tracks target debuffs.
      // A combo's slowdown stretches it (#70).
      const until = line.apply.duration != null ? timerEnd(frame.dilations ?? [], now, line.apply.duration) : Infinity;
      if (line.apply.duration == null) {
        note({ code: 'buffNoDuration', effect: line.effect.source.name });
      }
      const instance = live.get(key) ?? { line, expires: [] };
      // One slot, two skills: the one that fired last holds it (Liino's stances).
      if (line.effect.source.kind === 'skill') instance.line = line;
      if (line.apply.stacks?.from === 'consumed') {
        // "× Max number of stacks consumed": one buff, strength by what was consumed.
        const eaten = consumedCount(frame, line.source);
        if (eaten === 0) continue;
        if (line.apply.stacks.accumulate) {
          // «For every 1 stack consumed … can reach 6 stacks. Duration of each
          // stack is counted separately» (Argent Flow's P3): casts add up.
          for (let count = 0; count < eaten; count += 1) instance.expires.push(until);
          instance.expires.sort((a, b) => a - b);
          while (instance.expires.length > line.max) instance.expires.shift();
        } else {
          instance.expires = Array(Math.min(eaten, line.max)).fill(until);
        }
      } else if (line.max <= 1) {
        // Does not stack: a repeat trigger refreshes the duration.
        instance.expires = [until];
      } else {
        for (let count = 0; count < fired; count += 1) instance.expires.push(until);
        instance.expires.sort((a, b) => a - b);
        while (instance.expires.length > line.max) instance.expires.shift();
      }
      live.set(key, instance);
    }

    after.push(snapshot(frame.target));
    for (const key of spentKeys) live.delete(key);
    previous = frame.target;
  }

  return { frames: out, after, notes: [...notes.values()], extraHits };
}

/** Whether the step's cast matches a list like `cast:Battle Skill|cast:Ultimate`. */
export function castMatches(spec: string, frame: Frame): boolean {
  return spec.split('|').some((alternative) => {
    const [kind, arg] = splitTrigger(alternative);
    return kind === 'cast' && arg != null && castIs(arg, frame);
  });
}

/**
 * `Combo Skill` — any cast of that type; `Combo Skill@2` — the cast's second
 * sequence: a step written as `CS2`, or a whole `CS` that runs through it
 * («COMBO SEQUENCE 2 … buffs Rossi's Critical Rate»).
 */
function castIs(arg: string, frame: Frame): boolean {
  // A transformed move by name: `cast:Bolt Rush` (Argent Flow's Springvolt Galore).
  if (frame.transformed && arg === frame.transformed.into) return true;
  const [type, sequence] = arg.split('@');
  if (KIND_TO_SKILL[frame.step.kind] !== type) return false;
  if (sequence == null) return true;
  return frame.step.sequence == null || frame.step.sequence === Number(sequence);
}

/** How many stacks the holder consumed at this step (the largest of what was consumed). */
function consumedCount(frame: Frame, holder: string): number {
  return Math.max(
    0,
    ...frame.status
      .filter((event) => event.by === holder && (event.kind === 'consumesVulnerable' || event.kind === 'consumesInfliction'))
      .map((event) => event.consumed ?? 0),
  );
}

function splitTrigger(text: string): [string, string | null] {
  const at = text.indexOf(':');
  return at < 0 ? [text.trim(), null] : [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}

/** How many times the row triggered at this step (stacks to add). */
function timesFired(
  line: Line,
  frame: Frame,
  met: TargetState | undefined,
  recovered: Map<string, number>,
  note: (message: Message) => void,
  crits: Map<string, { total: number; added: number }> | null,
): number {
  const holder = line.source;
  const mine = frame.step.actor === holder;
  if (line.apply.controlled && frame.controlled !== holder) return 0;
  // «… to targets with Cryo Infliction or Solidification» (Xaihi's Execute
  // Process): the row fires only when the target the step met has one.
  if (line.apply.targetHas && !line.apply.targetHas.some((term) => targetHas(met, term, frame.world))) return 0;
  let fired = 0;
  for (const alternative of line.trigger.split('|')) {
    const [kind, arg] = splitTrigger(alternative);
    switch (kind) {
      case 'cast':
        if (mine && arg && castIs(arg, frame)) fired = Math.max(fired, 1);
        break;
      // «When any operator in the team casts a battle skill» (Type 50 Yinglung).
      case 'team_cast':
        if (arg && castIs(arg, frame)) fired = Math.max(fired, 1);
        break;
      case 'skill_hit':
        if (mine && ['BS', 'CS', 'ULT'].includes(frame.step.kind)) fired = Math.max(fired, 1);
        break;
      case 'final_strike':
        if (mine && frame.step.kind === 'FS') fired = Math.max(fired, 1);
        break;
      case 'applies': {
        // `applies:<term>@<skill type>` — applied by the holder's own skill of that type.
        const [term, by] = (arg ?? '').split('@');
        if (by && (!mine || KIND_TO_SKILL[frame.step.kind] !== by)) break;
        if (term && appliedBy(frame, holder).some((applied) => termMatches(applied, term))) fired = Math.max(fired, 1);
        break;
      }
      case 'consumes':
        if (arg && consumedBy(frame, holder).some((term) => termMatches(term, arg))) fired = Math.max(fired, 1);
        break;
      case 'sp_recovered': {
        const own = frame.spRecoveredBy[holder] ?? 0;
        if (own <= 0) break;
        if (!arg) {
          fired = Math.max(fired, 1);
          break;
        }
        // "Recovering 80 SP with his own skills": a stack for every N
        // accumulated — how many thresholds this step crossed.
        const step = Number(arg);
        const total = recovered.get(holder) ?? 0;
        const crossed = Math.floor(total / step) - Math.floor((total - own) / step);
        fired = Math.max(fired, crossed);
        break;
      }
      case 'stacks_reached': {
        // `stacks_reached:Melting Flame@4` — the holder's own stacks crossed 4 at this step.
        const [term, at] = (arg ?? '').split('@');
        const need = Number(at);
        if (frame.ownStacks.some((gain) => gain.operator === holder && gain.term === term && gain.from < need && gain.to >= need)) {
          fired = Math.max(fired, 1);
        }
        break;
      }
      case 'charge_spent':
        // A point of the holder's charge spent at this step, by anyone (Steel Oath).
        if (arg && frame.charges.some((charge) => charge.owner === holder && charge.name === arg)) fired = Math.max(fired, 1);
        break;
      case 'target_has':
      case 'hp_above':
        // States, not events: tracked at the start of the frame.
        break;
      case 'crit': {
        if (!crits) {
          note({ code: 'buffCritUntracked', effect: line.effect.source.name });
          break;
        }
        // Expected crits crossing whole numbers at this frame.
        const entry = crits.get(holder);
        if (!entry || entry.added <= 0) break;
        const crossed = Math.floor(entry.total + 1e-9) - Math.floor(entry.total - entry.added + 1e-9);
        note({ code: 'buffCritExpected', effect: line.effect.source.name });
        fired = Math.max(fired, crossed);
        break;
      }
      case 'damage_taken':
      case 'hp_restored':
        note({ code: 'buffNeverOnDummy', effect: line.effect.source.name, trigger: kind });
        break;
      default:
        note({ code: 'buffTriggerUntracked', effect: line.effect.source.name, trigger: alternative });
    }
  }
  return fired;
}
