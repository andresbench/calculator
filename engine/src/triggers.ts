/**
 * Combo triggers: what a rotation step is actually enabled by.
 *
 * This is the point of the whole `.rot` notation. A rotation in Endfield is
 * not a list of actions but a **dependency**: combo skills only fire on their
 * own trigger, and somebody earlier in the chain has to provide it. Chen's
 * combo needs the enemy to be Vulnerable; Mi Fu's needs three stacks;
 * Pogranichnik's needs a Crush or Breach to have consumed them.
 *
 * The text analysis stays in Python. `synergy.py` and `rotation.py` already
 * read the skill descriptions with regexes, and a second implementation of
 * that in TypeScript would drift from the first exactly the way two damage
 * formulas would. What the bundle carries is the **result**: who applies
 * which term, what each term implies, and the requirement groups of every
 * combo trigger.
 */

import type { Skill, SkillType } from './bundle.js';
import { isStackTerm } from './status.js';

/** One combo trigger, already parsed on the Python side. */
export interface ComboTrigger {
  skill: string;
  /** The sentence from the wiki, kept so the UI can show the real wording. */
  text: string;
  /**
   * Requirements split by "or".
   *
   * Every group must be satisfied, but any one term inside a group is
   * enough. "Crush **or** Breach consumes the Vulnerability stacks" becomes
   * `[["Crush", "Breach"], ["Vulnerable"]]`: either of the first two, plus
   * Vulnerable. Collapsing this into a flat list makes the validator reject
   * rotations that work perfectly well in game.
   */
  groups: string[][];
  /**
   * Terms that must NOT be on the target: "on an enemy with no stacks of
   * Vulnerability or Arts Infliction" (Ardelia). Any one of them standing
   * closes the combo.
   */
  absent?: string[];
  /**
   * The operator's own counter the trigger waits for: "When Typhoeus reaches
   * max Signs" → `Sign`. The engine does not keep it, so `groups` is empty
   * and the trigger is unread rather than never satisfied.
   */
  own?: string;
  /**
   * «While Vocalist Stance is active, …»: the caster's own stance, required
   * on top of the groups (Liino).
   */
  while?: string;
  /**
   * The trigger is the **moment stacks get consumed**, not their presence:
   * "when Heat Infliction is consumed or absorbed". Mixed wordings ("consumed
   * or is applied") stay `false` — presence alone opens those.
   */
  consumed?: boolean;
  /**
   * Mixed wording: "suffers Electrification **or after** an enemy's
   * Electrification **is consumed**" (Arclight). Presence opens it, and the
   * consumption opens it too.
   */
  orConsumed?: boolean;
  /** Stack thresholds: «3 or more Cryo Infliction stacks» → `{ 'Cryo Infliction': 3 }`. */
  min?: Record<string, number>;
  /**
   * The event that opens the combo, when it is an action rather than a
   * state: `FS` — "performs a Final Strike on an enemy with …", `FS|FIN` —
   * "Final Strike or Finisher", `CS` — "another operator in the team deals
   * DMG with combo skills", `STG` — "an enemy becomes Staggered or hits a
   * Stagger Node". The groups are then only the condition.
   */
  on?: string;
}

/**
 * A rule that depends on who stands in which team slot.
 *
 * The game numbers slots from 01, and slot 01 is not cosmetic: Si's battle
 * skill applies Heat instead of Cryo Infliction when slot 01 holds a Heat
 * operator, and her ultimate cuts slot 01's combo cooldown. Parsed from the
 * skill text on the Python side, like everything else here.
 */
export type TeamPositionRule =
  | {
      kind: 'swapTerm';
      /** Skill whose application changes. */
      skill: string;
      /** What it applies normally… */
      term: string;
      /** …and what it applies instead when the slot condition holds. */
      alt: string;
      slot: number;
      element: string;
      text: string;
    }
  | {
      kind: 'comboCooldownCut';
      /** Casting this skill cuts the cooldown. */
      skill: string;
      slot: number;
      /** Seconds taken off the cooldown that is **already running**. */
      seconds: number;
      /** Elite stage the talent level unlocks at; the highest reached wins. */
      elite: number;
      source: string;
      text: string;
    };

/** One operator's stock (`Synergy.stocks`), as `synergy.py` read it. */
export interface StockEntry {
  name: string;
  max: number;
  gainedBy: string;
  spentBy: string;
  /** What the spending cast makes: one per stock spent, plus `base`. */
  makes: string;
  base: number;
  /** Terms the cast applies only when it makes more than one. */
  onMany: string[];
}

/**
 * Stacks an operator holds on herself (`Synergy.ownStacks`): Laevatain's
 * Melting Flame. Her skills add them, her talent absorbs an infliction into
 * them, and one skill spends them all at `spentBy.at`.
 */
export interface OwnStackEntry {
  name: string;
  max: number;
  /** Skills that add stacks when they hit. */
  gains: Array<{ skill: string; count: number }>;
  /** Stacks her own Final Strike adds: the client's, not the text's (`frames.py`). */
  finalStrike?: number;
  spentBy: {
    skill: string;
    at: number;
    /** What the cast forces only when it spends them («forcibly trigger temporary Combustion»). */
    applies: string[];
    /** The spender's row of Ultimate Energy the extra attack restores. */
    energy?: string;
  };
  /**
   * «After the controlled operator's Final Strike or Finisher hits the enemy,
   * Laevatain absorbs Heat Infliction»: `count` stacks per absorbed stack,
   * from Elite `elite`. Absorbing is not consuming.
   */
  absorbs?: { talent: string; elite: number; term: string; count: number };
}

/** A charge one skill leaves on the target and the ultimate sets off (`Synergy.detonates`). */
export interface DetonateEntry {
  /** The battle skill that plants it. */
  skill: string;
  name: string;
  /** The ultimate's row with the increase: a separate multiplier (`ProdCalcZone` in the client). */
  boost: string;
  /** Seconds from the battle skill's start to its own explosion; `null` — unknown. */
  fuse: number | null;
}

/** A move an ultimate turns a skill into (`Synergy.transforms`). */
export interface TransformEntry {
  skill: SkillType;
  into: string;
  /** The skill type it is treated as, and whose rows it uses. */
  as: SkillType;
  /** «Costs no SP». */
  free: boolean;
  /** The granting skill's row with the window; missing — `<into> State Duration (s)`. */
  window?: string;
}

/**
 * A mark a reaction leaves and a Physical Status detonates (Argent Flow's
 * Sunderization, `synergy.marks`): stacks = the reaction's Status Level,
 * up to `max`, for `seconds`; the status on a marked target is ×`boost`
 * and sets off an explosion of `perStack` × ATK per stack, +`perPoint` per
 * point of the owner's Arts Intensity. `allTypes`: the reaction's DMG Taken
 * covers every DMG type, not only Arts (measurements, #59).
 */
export interface MarkEntry {
  name: string;
  reaction: string;
  max: number;
  seconds: number;
  allTypes: boolean;
  status: string;
  element: string;
  byElite: Array<{ elite: number; boost: number; perStack: number }>;
  aiByElite?: Array<{ elite: number; perPoint: number }>;
}

/** A forced reaction whose level counts the stacks the cast consumed (Argent Flow's Bolt Rush). */
export interface ForcedLevelEntry {
  reaction: string;
  /** The infliction whose consumed stacks set the level. */
  per: string;
}

/** One cast's points (`Synergy.charges`), as `synergy.py` read them. */
export interface ChargeEntry {
  name: string;
  points: number;
  /** Target statuses whose application spends a point. */
  on: string[];
  /** The owner's own combo spends one too. */
  combo: boolean;
  /** Row prefix landing on every spent point: «Harass». */
  each: string;
  /** Row prefix landing with the last one: «Decisive Assault». */
  last?: string;
}

export interface Synergy {
  /** operator key → term → names of the skills that apply it. */
  applies: Record<string, Record<string, string[]>>;
  /** operator key → rules that read the team slots. */
  teamPosition?: Record<string, TeamPositionRule[]>;
  /**
   * operator key → stack term → skills that **consume** it by their own
   * action («consume all Cryo Infliction stacks»). Trigger text is excluded
   * on the Python side: Camille's «when Heat Infliction is consumed» is a
   * condition, not something he does.
   */
  consumes?: Record<string, Record<string, string[]>>;
  /**
   * operator key → reaction → skills that apply it **forcibly**. Per the
   * wiki, forced reactions do not consume inflictions and come at Status
   * Level I.
   */
  forced?: Record<string, Record<string, string[]>>;
  /**
   * operator key → skill → the action that actually delivers its terms.
   * Last Rite's battle skill puts nothing on the target itself: the next
   * Final Strike of the controlled operator does.
   */
  deferred?: Record<string, Record<string, 'FS'>>;
  /**
   * operator key → skills whose cast makes the caster the controlled
   * operator: Laevatain's and Yvonne's ultimates.
   */
  takesControl?: Record<string, string[]>;
  /**
   * operator key → skill → the stance its cast enters and the one it
   * replaces: Liino's battle skill enters Vocalist Stance, her ultimate
   * Cosmovoice Stance in its place. The length is the skill's
   * `<Stance> Duration (s)` row.
   */
  stances?: Record<string, Record<string, { enters: string; replaces?: string }>>;
  /**
   * operator → skill → points its cast generates and what spends them.
   * Pogranichnik's ultimate: 5 Steel Oath; a step that applies a Physical
   * Status, or his combo, spends one: the skill's `Harass …` rows land then,
   * and `Decisive Assault …` with the last. Duration — the `<name> Duration`
   * row.
   */
  charges?: Record<string, Record<string, ChargeEntry>>;
  /**
   * operator → ultimate → the move its cast turns the battle skill into.
   * Camille: Hunter Pursuit, «treated as a combo skill and costs no SP», for
   * the ultimate's `<move> State Duration (s)`. Its rows are the `as`
   * skill's rows with `move`.
   */
  transforms?: Record<string, Record<string, TransformEntry>>;
  /** Forced reactions leveled by consumed stacks, by operator and skill or move. */
  forcedLevels?: Record<string, Record<string, ForcedLevelEntry>>;
  /** Marks a reaction leaves and a status detonates, by operator. */
  marks?: Record<string, MarkEntry>;
  /** Vulnerable stacks a skill or move adds directly, after consuming `after` (Bolt Rush). */
  vulnerableStacks?: Record<string, Record<string, { count: number; after: string }>>;
  /**
   * operator → what one skill leaves on the field and another spends.
   * Tangtang: her combo leaves a Whirlpool (up to 2, `Whirlpool Duration
   * (s)` each), her battle skill takes all of them, one more Waterspout and
   * one `SP Return per Whirlpool` each; with several Waterspouts it also
   * applies Arts Susceptibility.
   */
  stocks?: Record<string, StockEntry>;
  /** operator → her own stacks (`OwnStackEntry`): Laevatain's Melting Flame. */
  ownStacks?: Record<string, OwnStackEntry>;
  /**
   * operator → ultimate → the battle skill's charge it detonates. Fluorite:
   * her battle skill sticks an Improvised Explosive that goes off after its
   * fuse; her ultimate, cast while it is stuck, sets it off at once with
   * `Battle Skill DMG Boost`. The explosion is the battle skill's own hit.
   */
  detonates?: Record<string, Record<string, DetonateEntry>>;
  /**
   * operator → skill → the elements it repeats: one more stack of whichever
   * is already on the target with at least `min` stacks. Fluorite's combo
   * and ultimate name Cryo and Nature, and land only the one that is there.
   */
  echoes?: Record<string, Record<string, { elements: string[]; min: number }>>;
  /**
   * operator → the battle skill whose term makes the next basic attack a
   * Final Strike, from `elite` on: Yvonne's Barrage of Technology after
   * Solidification. That attack is one hit, not the whole chain.
   */
  strikeAfter?: Record<string, { skill: string; term: string; elite: number; talent: string }>;
  /**
   * term → terms that follow from it.
   *
   * Two kinds of link. Consequence: Lift and Knock Down apply Vulnerable.
   * Genus: Heat Infliction is a kind of Arts Infliction, so a trigger asking
   * for Arts Infliction is closed by any element.
   */
  implications: Record<string, string[]>;
  comboTriggers: Record<string, ComboTrigger>;
}

export const EMPTY_SYNERGY: Synergy = { applies: {}, implications: {}, comboTriggers: {} };

/**
 * Terms present on the target, with the step that put them there.
 *
 * Kept as "who provided it and when" rather than a plain set, because the
 * interesting answer is not "is the combo open" but **"what opened it"**.
 */
export type Provided = Map<string, number>;

/**
 * Records a term and everything that follows from it.
 *
 * Recursive because implications chain: Lift gives Vulnerable, and both are
 * Physical Status. The `seen` guard exists because the glossary is a graph,
 * not a tree, and it does contain cycles.
 */
export function provide(
  provided: Provided,
  synergy: Synergy,
  term: string,
  step: number,
  seen: Set<string> = new Set(),
): void {
  if (seen.has(term)) return;
  seen.add(term);
  if (!provided.has(term)) provided.set(term, step);
  for (const implied of synergy.implications[term] ?? []) {
    provide(provided, synergy, implied, step, seen);
  }
}

/** Everything a given skill puts on the target, including implications. */
export function applySkill(
  provided: Provided,
  synergy: Synergy,
  operatorKey: string,
  skill: Skill | undefined,
  step: number,
  /** Terms the skill does not apply this time, e.g. lost to a slot condition. */
  exclude: ReadonlySet<string> = new Set(),
): string[] {
  if (!skill) return [];
  const applied: string[] = [];
  for (const [term, skills] of Object.entries(synergy.applies[operatorKey] ?? {})) {
    if (exclude.has(term)) continue;
    if (skills.includes(skill.name)) {
      provide(provided, synergy, term, step);
      applied.push(term);
    }
  }
  return applied;
}

export interface TriggerCheck {
  trigger: ComboTrigger | null;
  /** Which term closed each group, and at which step. */
  satisfiedBy: Array<{ term: string; step: number }>;
  /** Groups nobody provided. */
  missing: string[][];
  /** Forbidden terms (`absent`) standing on the target now. */
  present: string[];
  /** The stance the trigger needs (`while`), when the caster is not in it. */
  outOfStance?: string;
}

/** Nothing missing, nothing forbidden in the way, the stance is up. */
export function isOpen(check: TriggerCheck): boolean {
  return check.missing.length === 0 && check.present.length === 0 && !check.outOfStance;
}

/**
 * Checks a combo skill's trigger against what is already on the target.
 *
 * An operator with no recorded trigger comes back as `trigger: null` and no
 * complaints: absence of a parsed trigger means we could not read it, not
 * that the skill is free to cast. Saying "fine" there would be inventing.
 */
export function checkTrigger(
  synergy: Synergy,
  operatorKey: string,
  provided: Provided,
  live?: LiveTarget,
): TriggerCheck {
  const parsed = synergy.comboTriggers[operatorKey] ?? null;
  // A trigger with nothing parsed out of it — "when the controlled operator
  // is attacked" — is as unread as a missing one: the track cannot see the
  // event, and an empty condition must not read as "always open".
  const trigger = parsed && (parsed.on || parsed.groups.length > 0) ? parsed : null;
  if (!trigger) return { trigger: null, satisfiedBy: [], missing: [], present: [] };

  const satisfiedBy: Array<{ term: string; step: number }> = [];
  const missing: string[][] = [];

  const hitOf = (term: string): number | null => {
    if (live && isStackTerm(term)) {
      // «Stacks consumed» is an event: it opens the combo once, and only
      // if it happened after this combo was last cast.
      if (trigger.consumed) {
        const at = live.consumedAt.get(term);
        return at !== undefined && at > live.lastCast ? at : null;
      }
      // «Has 3 or more stacks» is a state: what stands on the target NOW,
      // not whether it was ever applied.
      const count = live.count(term);
      if (count !== null) {
        const min = trigger.min?.[term];
        if (count >= (min ?? 1)) return live.latest.get(term) ?? provided.get(term) ?? 0;
        // Without a threshold the trigger is the application itself: Heat on
        // Electric turns into Combustion at once, no stacks stay, and Rossi's
        // combo still opens (measurements, #4, 2026-10-28).
        const at = live.latest.get(term);
        return min === undefined && at !== undefined && at > live.lastCast ? at : null;
      }
    }
    if (live && trigger.orConsumed) {
      const at = live.consumedAt.get(term);
      if (at !== undefined && at > live.lastCast) return at;
    }
    // A timed debuff that is gone: with an action trigger the condition is
    // read at the action — Lifeng's Final Strike on an expired Physical
    // Susceptibility opens nothing. Without one the application itself is
    // the event (measurements, #4): Estella's Solidification, shattered at
    // once, still opens her combo. A «consumed» trigger wants it gone anyway.
    if (!trigger.consumed && live?.active?.(term) === false) {
      const at = live.latest.get(term);
      return !trigger.on && at !== undefined && at > live.lastCast ? at : null;
    }
    return provided.has(term) ? provided.get(term)! : null;
  };

  // An action trigger: the Final Strike (or another operator's combo) is the
  // event, and it has to come after this combo's last cast. The groups stay
  // the condition on the target.
  if (trigger.on && live?.strikes) {
    const kinds = trigger.on.split('|');
    const latest = (kind: string): number => {
      if (kind !== 'CS') return live.strikes!.get(kind) ?? 0;
      let at = 0;
      for (const [key, step] of live.strikes!) {
        if (key.startsWith('CS:') && key !== `CS:${operatorKey}`) at = Math.max(at, step);
      }
      return at;
    };
    const at = Math.max(0, ...kinds.map(latest));
    const term = kinds.includes('CS')
      ? 'Combo Skill'
      : kinds.includes('STG')
        ? 'Staggered or Stagger Node'
        : kinds.includes('FIN')
          ? 'Final Strike or Finisher'
          : 'Final Strike';
    if (at > live.lastCast) satisfiedBy.push({ term, step: at });
    else missing.push([term]);
  }

  for (const group of trigger.groups) {
    let hit: { term: string; step: number } | null = null;
    for (const term of group) {
      const step = hitOf(term);
      if (step !== null) {
        hit = { term, step };
        break;
      }
    }
    if (hit) satisfiedBy.push(hit);
    else missing.push(group);
  }

  // Only live counts can tell that a stack is NOT there; "was it ever
  // provided" cannot, so without them the condition is not judged.
  const present = live ? (trigger.absent ?? []).filter((term) => (live.count(term) ?? 0) > 0) : [];
  const outOfStance = trigger.while && live?.inStance && !live.inStance(trigger.while) ? trigger.while : undefined;

  return { trigger, satisfiedBy, missing, present, ...(outOfStance ? { outOfStance } : {}) };
}

/**
 * The target as a trigger sees it: live stack counts and consumption events.
 *
 * Without it `checkTrigger` falls back to "was the term ever provided",
 * which is how it worked before stacks were tracked — and why Last Rite's
 * «3 or more Cryo Infliction stacks» opened on the very first stack.
 */
export interface LiveTarget {
  /** Stacks standing now; `null` when the term is not a stack counter. */
  count: (term: string) => number | null;
  /**
   * Whether a timed debuff stands on the target now; `null` when the term is
   * not kept as one. "An enemy with active Focus" is a state: Focus applied a
   * minute ago and expired does not open the combo.
   */
  active?: (term: string) => boolean | null;
  /** Whether the combo's own operator is in the named stance now. */
  inStance?: (stance: string) => boolean;
  /** Step at which the term's stacks were last consumed. */
  consumedAt: Provided;
  /** Step of the latest application of each term. */
  latest: Provided;
  /** Step at which this combo was last cast; 0 if never. */
  lastCast: number;
  /**
   * Step of the latest Final Strike (`FS`), Finisher (`FIN`), stagger or
   * Stagger Node (`STG`) and each operator's combo (`CS:<key>`), for action
   * triggers.
   */
  strikes?: Map<string, number>;
}
