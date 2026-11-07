/**
 * Rotation track simulation.
 *
 * A parsed rotation and the team's builds go in; frames come out: SP,
 * energy, cooldowns and the target at every moment. The track UI draws its
 * strip straight from the frames, the CLI prints them as a table.
 *
 * Resource numbers come from the `Skill Points` and `Ultimate Energy` pages:
 *
 * * SP is shared by the team, capped at 300, and regenerates passively (the
 *   wiki says 8 per second; the rate used is in `sp.yaml`, measurements #20);
 * * battle skills usually cost 100, sometimes 50 or 25;
 * * **returned SP is not the same as recovered SP**: it does not trigger
 *   "on SP recovery" effects, and spending returned SP gives no ultimate
 *   energy;
 * * a battle skill cast gives the whole team 6.5 energy per 100 SP spent
 *   (not returned);
 * * a combo gives its caster 10 energy unless the skill says otherwise.
 */

import type { Bundle, Operator, Skill, SkillEnhancedBasic, SkillGrant, SkillType } from './bundle.js';
import { grantModifiers, type EffectModifiers, type GrantModifier } from './effects.js';
import { stagesArePresses } from './actions.js';
import {
  durationOf,
  FILLER_KINDS,
  freezesTimers,
  type ActionKind,
  type Timings,
} from './timing.js';
import type { RotStep } from './rot.js';
import {
  applySkill,
  checkTrigger,
  isOpen,
  EMPTY_SYNERGY,
  provide,
  type ChargeEntry,
  type OwnStackEntry,
  type StockEntry,
  type TransformEntry,
  type Provided,
  type LiveTarget,
  type Synergy,
  type TeamPositionRule,
  type MarkEntry,
  type ComboTrigger,
  type TriggerCheck,
} from './triggers.js';
import {
  classify,
  durationForTerm,
  INFLICTION_ELEMENTS,
  INFLICTION_SECONDS,
  inflictionElement,
  isStackTerm,
  MAX_STACKS,
  REACTION_OF,
  type ArtsElement,
  type StatusEvent,
} from './status.js';
import { BREACH_DEBUFF } from './damage.js';
import { holds, type HitContext } from './hits.js';
import type { Message } from './messages.js';

export const SP_CAP = 300;
/**
 * Passive SP regeneration, SP per second.
 *
 * The wiki says 8, and the client's Final Strike values agree: a community
 * table's measured "seconds of bar returned" times 8 gives the client's
 * `atb` for 26 operators of 28 (measurements, #20). An earlier 100/13 came
 * from that table's note, not its data.
 */
export const SP_REGEN_PER_SECOND = 8;
/** Energy to the whole team per 100 SP spent (returned SP does not count). */
export const ENERGY_PER_100_SP = 6.5;
/** Ultimate energy an operator can hold. */
export const ENERGY_CAP = 200;
/** Energy a combo gives its caster when the skill does not say otherwise. */
export const COMBO_ENERGY = 10;
/**
 * Link bonus by the number of Link buffs spent at once (wiki, `Link`): the
 * next Battle Skill or Ultimate cast by the team spends all of them, with
 * diminishing returns.
 */
export const LINK_BONUS: Record<'BS' | 'ULT', number[]> = {
  BS: [0.3, 0.45, 0.6, 0.75],
  ULT: [0.2, 0.3, 0.4, 0.5],
};

/** Index into a skill's twelve per-level values. */
function levelIndex(level: number): number {
  return Math.min(Math.max(level, 1), 12) - 1;
}

/** Actions that use a skill: everything but a dodge and a pause. */
export type SkillAction = Exclude<ActionKind, 'DODGE' | 'WAIT'>;

/** Which skill a `.rot` action uses: every basic-attack form is the Basic Attack. */
export const KIND_TO_SKILL: Record<SkillAction, SkillType> = {
  BA: 'Basic Attack',
  FS: 'Basic Attack',
  FIN: 'Basic Attack',
  DIVE: 'Basic Attack',
  BS: 'Battle Skill',
  CS: 'Combo Skill',
  ULT: 'Ultimate',
};

/** The skill an action uses; `null` for a dodge or a pause. */
export function skillTypeOf(kind: ActionKind): SkillType | null {
  return FILLER_KINDS.has(kind) ? null : KIND_TO_SKILL[kind as SkillAction];
}

/** A skill stat's value at the given level, accounting for the stage. */
export function statAt(
  skill: Skill,
  label: string | RegExp,
  level: number,
  sequence: number | null = null,
): number | null {
  const row = skill.stats.find((stat) =>
    typeof label === 'string' ? stat.label === label : label.test(stat.label),
  );
  if (!row) return null;
  const index = levelIndex(level);
  // For multi-stage skills the wiki lists the sequences in a row: Mi Fu's
  // "SP Cost" is 100 for the first stage and 50 each for the second and third.
  if (sequence != null && row.sequences && row.sequences.length >= sequence) {
    return row.sequences[sequence - 1]?.[index] ?? null;
  }
  return row.values[index] ?? null;
}

/**
 * SP the wiki does not quantify: Final Strike and Finisher recovery.
 *
 * The `Skill Points` page gives only the Final Strike range (15 for
 * Fluorite, 30 for Last Rite) and says Finisher recovery is "based on the
 * enemy" without any figures. Values come from `data/endfield/sp.yaml` and
 * are flagged wherever they reach a number.
 */
export interface SpTable {
  finalStrike: { default: number; known: Record<string, number>; confidence: string };
  finisher: { default: number; byClass: Record<string, number>; confidence: string };
  /** Passive regeneration, SP per second. Missing: `SP_REGEN_PER_SECOND`. */
  passiveRegen?: number;
  /**
   * Basic attacks by operator key (`data/endfield/basic_attacks.json`, from
   * the client): basic-chain length, the last hit's share of it (the Final
   * Strike) and Final Strike SP. `uncertain` says why the length is in
   * doubt; such a length is scaled like any unmeasured one.
   */
  basicAttack?: Record<
    string,
    {
      sequenceSeconds?: number;
      finalStrikeSeconds?: number;
      finalStrikeSp?: number;
      uncertain?: string;
      /**
       * When another action may start after this operator's combo or
       * ultimate, from the client (`frames.py`, measurements #35). The
       * ultimate's `cutscene` is also how long natural SP regen stands still.
       */
      skillWindows?: Partial<Record<'BS' | 'CS' | 'ULT', SkillWindow>>;
      /**
       * Hits of the basic chain on an enemy, seconds from the chain's start,
       * the attacker's hit stops included (#68b); one list per segment, the
       * last is the Final Strike (`frames.py`).
       */
      chainHits?: number[][];
      /**
       * Seconds from the chain's start to the Final Strike's hit: the last
       * segment's hit that restores SP — what opens Final Strike combos
       * (measurements, #68c; `frames.py`).
       */
      finalStrikeHit?: number;
      /**
       * A dive from the ground (`frames.py`, measurements #21): the measured
       * fall plus the client's landing — `seconds` to the next action, `hit`
       * when the landing strikes.
       */
      dive?: { seconds: number; hit: number };
      /**
       * A finisher (`power_attack`, measurements #21): seconds to the next
       * attack and its hits from the press. `fitted` — the hit stop reading
       * is fitted on Chen alone.
       */
      finisher?: { seconds: number; hits: number[]; fitted?: boolean };
      /** Hits of each skill, seconds from the press, hit stop included (`frames.py`). */
      skillHits?: Partial<Record<'BS' | 'CS' | 'ULT', SkillHit[]>>;
    }
  >;
  /** Perfect Dodge (wiki, `Skill Points`): SP it recovers, and seconds natural regen pauses. */
  perfectDodge?: { sp: number; regenPause: number };
}

/** One hit of a skill from the client (`basic_attacks.json`, `skillHits`). */
export interface SkillHit {
  /** Seconds from the press, the hit stops of the hits before it included (#63). */
  at: number;
  /** The hit puts a status on the target (Knock Down, Lift, an infliction…). */
  status?: boolean;
  /** After the skill's first window: possibly another variant of the move (`frames.py`). */
  late?: boolean;
}

/** A combo's or an ultimate's window from the client (`basic_attacks.json`). */
export interface SkillWindow {
  seconds: number;
  /** `allowNext`, `exclusive`, `ultimateTime`, `hideUi`: which frame it was read from. */
  from: string;
  /** Checked on video (measurements, #35). */
  measured?: boolean;
  /** Ultimate: the cutscene, during which natural SP regen stops. */
  cutscene?: number;
  /**
   * Combo: seconds the world slows for everyone but the caster — another
   * operator's chain, a combo cast before it, natural SP regen (#64, #66).
   */
  dilation?: number;
  /** Battle skill: how long it holds ANOTHER operator (its own waits `seconds`). */
  other?: number;
  /**
   * Battle skill: seconds from the cast to the hit that puts its statuses on
   * the target (measurements, #63). Shorter than the step it lands after.
   */
  lands?: number;
  /** `lands` checked on video (#63, Lifeng). */
  landsMeasured?: boolean;
}

export const FALLBACK_SP: SpTable = {
  finalStrike: { default: 20, known: { Fluorite: 15, 'Last Rite': 30 }, confidence: 'unknown' },
  finisher: { default: 25, byClass: {}, confidence: 'unknown' },
};

/** The dummy the rotation is played against. */
export interface Target {
  /** Size of the stagger meter. Null means stagger is not simulated. */
  staggerMeter: number | null;
  /** Seconds the staggered state lasts. */
  staggerRecovery: number;
  /** Stagger Nodes as shares of the meter; empty when the enemy has none. */
  staggerNodes?: number[];
  /** Finisher Multiplier for this enemy: the wiki's `SD` field. */
  finisherMultiplier: number;
  /**
   * SP a Finisher on this enemy refunds: the wiki's `SPG` field, labelled
   * "Finisher SP Gain" in Template:Enemy data.
   *
   * It scales hard with tier — Common 25, Advanced 35, Alpha 50, Boss 100 —
   * so a finisher on a boss hands back a whole skill bar. That is why
   * finishers are worth routing a rotation around, not just extra damage.
   */
  finisherSp: number;
  name: string;
}

export const DUMMY: Target = {
  staggerMeter: null,
  staggerRecovery: 0,
  finisherMultiplier: 1,
  finisherSp: 0,
  name: 'dummy',
};

/**
 * One operator of the squad.
 *
 * **The order of the team map is the team position.** The first entry is
 * slot 01, and the game reads it: default combo priority, Si's cooldown cut
 * and her Heat/Cryo choice all look at who stands there. Build the map in
 * the order of the rotation's `team:` line, not in order of first action.
 */
export interface TeamMember {
  key: string;
  /**
   * Team position from 1. Missing — the position in the map. Set when the
   * squad has an empty slot: `team: Lifeng, -, -, Endministrator` puts her
   * in 04, not 02.
   */
  slot?: number;
  operator: Operator;
  level: number;
  /** Elite stage. Unknown means "assume the highest talent level". */
  elite?: number;
  skills: { basic: number; battle: number; combo: number; ultimate: number };
}

/**
 * The squad from the roster: levels, elite and skills come from the profile
 * if there is one.
 *
 * The order is squad position: first `order` (the `team:` line), then anyone
 * who acts in the steps but is not listed in the team. Keys unknown to the
 * bundle are skipped: the engine will rightly flag those operators' steps as
 * errors.
 */
export function teamFromRoster(
  bundle: Bundle,
  order: string[],
  steps: RotStep[] = [],
): Map<string, TeamMember> {
  const team = new Map<string, TeamMember>();
  const keys = [...order, ...steps.flatMap((step) => (step.actor ? [step.actor] : []))];
  const taken = new Set(order.map((key, index) => (key ? index + 1 : 0)));
  let free = 1;
  for (const [index, key] of keys.entries()) {
    if (!key || team.has(key)) continue;
    const operator = bundle.operators[key];
    if (!operator) continue;
    const entry = bundle.roster?.operators?.[key];
    // Someone acting but not in `team:` takes the first free slot.
    let slot = index + 1;
    if (index >= order.length) {
      while (taken.has(free)) free += 1;
      slot = free;
      taken.add(free);
    }
    team.set(key, {
      key,
      slot,
      operator,
      level: entry?.level ?? 90,
      ...(entry?.elite != null ? { elite: entry.elite } : {}),
      skills: entry?.skills ?? { basic: 1, battle: 1, combo: 1, ultimate: 1 },
    });
  }
  return team;
}

/** A debuff on the target: who applied it and when it expires. */
export interface Debuff {
  term: string;
  source: string;
  appliedAt: number;
  expiresAt: number | null;
  /** Status Level of the reaction or Breach: Shatter and the debuff's strength depend on it. */
  level?: number;
  /** The skill that applied it: a Susceptibility's value is that skill's row (`Skill.grants`). */
  skill?: string;
  /** An Amp that reached one operator, not the squad: Xaihi's Auxiliary Crystal. */
  receiver?: string;
  /** Damage per tick against the plain reaction's: Laevatain's P3 Combustion, ×1.5. */
  dotScale?: number;
  /** Its DMG Taken covers every DMG type (Argent Flow's Electrification, `MarkEntry.allTypes`). */
  allTypes?: boolean;
  /** Already turned into mark stacks. */
  marked?: boolean;
}

/** A grant waiting for its strike: the Auxiliary Crystal until a Final Strike. */
interface ArmedGrant {
  owner: string;
  skill: Skill;
  grant: SkillGrant;
  level: number;
  until: number;
  left: number;
}

export interface TargetState {
  /** Vulnerable stacks, at most four. Crush and Breach EAT them. */
  vulnerable: number;
  /** Arts Infliction stacks by element, up to four per element. */
  inflictions: Record<ArtsElement, number>;
  debuffs: Debuff[];
  staggered: boolean;
  /** Accumulated stagger. It does not grow while the target is stunned. */
  stagger: number;
  /** World time at which the target leaves the stun. */
  staggeredUntil: number;
  /** Marks waiting for a status to set them off (Argent Flow's Sunderization). */
  marks: Array<{ term: string; by: string; stacks: number; expiresAt: number }>;
}

export interface Frame {
  step: RotStep;
  /** The time by which buffs and debuffs expire. */
  world: number;
  /** Real time: damage per second is counted by it. */
  real: number;
  duration: number;
  sp: number;
  energy: Record<string, number>;
  cooldowns: Record<string, number>;
  /** The target after the step. */
  target: TargetState;
  /**
   * Whether the target was staggered as the step began, after what ran out
   * by then. Hits of the step take the Staggered +30 % by this, not by
   * `target`: the step that fills the meter ends staggered, and a finisher
   * ends with the stagger spent.
   */
  staggeredAtStart: boolean;
  /**
   * The cast's first hit filled the meter (its `First Strike Stagger`): that
   * hit lands without the Staggered +30 %, every later hit of the cast with
   * it. Chen's ultimate: the first slash 8,859, the second 12,076 = ×1.3
   * (measurements, #45). Absent — the step broke nothing, or broke it with
   * its stagger as a whole, and its hits go by `staggeredAtStart`.
   */
  brokenByFirstHit?: boolean;
  /** What happened to stacks at this step: applied, consumed, Status Level. */
  status: StatusEvent[];
  /** What went wrong: short of SP, a combo not opened and so on. Text: `formatMessage`. */
  problems: Message[];
  /** This step's verdicts; a key is stable between passes. Text: `formatMessage`. */
  verdicts: Map<string, Message>;
  /**
   * Combos whose trigger is open after this step, and when they can be
   * pressed (end of the step or end of the cooldown). The track draws a
   * "combo available" hint from them even if the rotation does not use it.
   * `by` — the step whose hit opened it inside this one: a background
   * battle skill landing mid-step (#63); `at` is then that hit.
   */
  /**
   * Combos lit after this step: when each can be pressed (`at`), and the
   * moment its trigger fired (`openedAt`, #65) — a new moment is a new
   * lighting, even if the combo was lit before.
   */
  combos: Array<{ key: string; at: number; by?: number; openedAt?: number }>;
  /** What the step applied to the target, and who: `applies:` buffs trigger on it. */
  applied: Array<{ term: string; by: string }>;
  /**
   * SP recovered by this step's skill ("SP Recovery") — neither a refund
   * nor passive regen. Frontiers, Thermite Cutter and Fervent Morale
   * ("recovers SP") trigger on it.
   */
  spRecovered: number;
  /**
   * Recovered SP by whose skill it was: the actor's `spRecovered`, plus
   * points another operator's cast left and this step spent (Pogranichnik's
   * Steel Oath recovers SP on a teammate's Physical Status). "Recovering 80 SP
   * with his own skills" counts by this.
   */
  spRecoveredBy: Record<string, number>;
  /**
   * The move this battle skill was turned into (`Synergy.transforms`): its
   * rows are the `as` skill's rows with that `move`. Camille's Hunter Pursuit.
   */
  transformed: { into: string; as: SkillType } | null;
  /**
   * A basic attack inside the ultimate that enhances it (`Skill.enhancedBasic`):
   * its rows are the `move` rows of that ultimate. Laevatain's Enhanced BATK.
   */
  enhancedBasic: { move: string; skill: string } | null;
  /** The battle skill inside the ultimate's window: the `move` its rows are (`Skill.duringUltimate`). */
  duringUltimate: string | null;
  /** Own stacks this step added (`Synergy.ownStacks`), from and to: «after reaching 4 stacks» reads it. */
  ownStacks: Array<{ operator: string; term: string; from: number; to: number }>;
  /** What this cast spent of its stock and how many it made (`Synergy.stocks`): Tangtang's Whirlpools into Waterspouts. */
  stock: { name: string; spent: number; made: number } | null;
  /**
   * The charge this ultimate set off (`Synergy.detonates`): the battle skill
   * that planted it, at which step, and the ultimate's row with the
   * increase. Its hit lands here instead of at that step.
   */
  detonated: { skill: string; step: number; boost: string } | null;
  /** Points spent at this step (`Synergy.charges`): their rows land here, as the owner's. */
  charges: Array<{ owner: string; skill: string; name: string; last: boolean; sp: number }>;
  /**
   * Stacks for this step's per-stack rows: how many it consumed itself, or,
   * for a combo with a "stacks consumed" trigger, how many the opening event
   * consumed (Si's combo counts damage from stacks consumed by Last Rite).
   */
  stacksForHit: number;
  /**
   * Sequences the cast performed, when the stacks decide it
   * (`Skill.moves`): Pogranichnik's combo on 3 consumed stacks slashes three
   * times. `null` — the skill is not like that.
   */
  moves: number | null;
  /** The enhanced sequence replaced the plain one (Pogranichnik's 4th stack). */
  enhanced: boolean;
  /** Link spent by this cast and the bonus it gives: 1 Link on a Battle Skill is +30 %. */
  link: { count: number; bonus: number } | null;
  /** Link buffs standing on the team after the step. */
  links: Debuff[];
  /**
   * A Final Strike that finishes the chain of the operator's BA just before
   * it: only the last hit. A Final Strike on its own walks the whole chain.
   */
  chained: boolean;
  /**
   * The controlled operator after this step: whoever performed it, if it is
   * a controlled action, or cast a skill that takes control (Laevatain's
   * ultimate); otherwise unchanged. `null` — an empty team.
   */
  controlled: string | null;
  /**
   * What the press held, seconds from `world` (`Holds`). `duration` is
   * `holds.own`: how long the operator is busy. Under `schedule: 'steps'`
   * every hold is the duration.
   */
  holds: Holds;
  /**
   * The step's length came from the client's frames, so the client's hit
   * times (`hit.at`) are on the same clock. A nominal second is not: its
   * hits stay at the press.
   */
  clientTimed: boolean;
  /**
   * The run's combo slowdowns and cutscenes (`SimulationResult.dilations`,
   * the same list for every frame): a hit of this step comes later by those
   * its operator is not exempt from (`warp`).
   */
  dilations?: readonly Dilation[];
}

export interface Wait {
  step: number;
  seconds: number;
  reason: string;
}

/**
 * SP over time: one point per change, so the track can draw it as a graph.
 *
 * The cap is 300, three skill bars of 100. The bar boundaries matter to a
 * player because most Battle Skills cost exactly one bar, so "how many bars
 * do I have" is the question being asked, not "how many points".
 */
export interface SpPoint {
  t: number;
  sp: number;
  /** Natural regen is paused from this point to the next (a perfect dodge). */
  paused?: boolean;
}

export interface SimulationResult {
  frames: Frame[];
  /** SP at every moment it changed. Cap 300 = three bars of 100. */
  spTimeline: SpPoint[];
  world: number;
  real: number;
  /**
   * Total time spent waiting on cooldowns and SP.
   *
   * This time is **derived**, and it rests on real wiki data rather than a
   * guessed action length. The larger the waiting share, the less the result
   * depends on the nominal second.
   */
  waited: number;
  waits: Wait[];
  /** Passive regen used, SP per second: `spAt` needs it between points. */
  regen: number;
  /** Who is controlled before the first step: `controlledAtStart`. */
  controlled: string | null;
  /** Combo slowdowns (`Dilation`): a hit of a step comes later by those it is not exempt from (`warp`). */
  dilations: Dilation[];
}

/**
 * SP at world time `t`, regen included.
 *
 * The timeline records only changes; between two points SP does nothing but
 * regenerate, so the value at `t` is the last point plus regen since, capped.
 * A frame's `sp` is the value right after its step resolves — reading that
 * under the playhead shows SP standing still through every animation.
 */
export function spAt(timeline: SpPoint[], t: number, regen: number): number {
  let last: SpPoint | undefined;
  for (const point of timeline) {
    if (point.t <= t + 1e-9) last = point;
    else break;
  }
  if (!last) return SP_CAP;
  if (last.paused) return last.sp;
  return Math.min(SP_CAP, last.sp + Math.max(0, t - last.t) * regen);
}

const SKILL_FIELD: Record<SkillType, keyof TeamMember['skills']> = {
  'Basic Attack': 'basic',
  'Battle Skill': 'battle',
  'Combo Skill': 'combo',
  Ultimate: 'ultimate',
};

function cloneTarget(target: TargetState): TargetState {
  return {
    vulnerable: target.vulnerable,
    inflictions: { ...target.inflictions },
    debuffs: target.debuffs.map((debuff) => ({ ...debuff })),
    staggered: target.staggered,
    stagger: target.stagger,
    staggeredUntil: target.staggeredUntil,
    marks: target.marks.map((mark) => ({ ...mark })),
  };
}

/** Stagger a single action applies, summed across the skill's stat rows. */
export function staggerOf(
  skill: Skill,
  level: number,
  sequence: number | null,
  move: string | null = null,
  context: HitContext = {},
  /** Row prefixes that are not this cast's: Steel Oath's Decisive Assault lands with the last point. */
  skip: readonly string[] = [],
  /** Only the rows with this prefix. */
  only: string | null = null,
): number {
  const index = levelIndex(level);
  // An enhanced stage that held replaces the plain stage's Stagger (Pogranichnik's third slash).
  const replaced = new Set(
    skill.stats
      .filter((row) => row.stagger?.conditional && row.stagger.when?.startsWith('stacks:') && holds(row.stagger.when, context))
      .map((row) => row.stagger!.sequence),
  );
  let total = 0;
  for (const row of skill.stats) {
    // A move's rows (Camille's Hunter Pursuit Stagger) are not the host cast's stagger.
    if (row.unit !== 'stagger' || (row.move ?? null) !== move) continue;
    if (skip.some((prefix) => row.label.startsWith(prefix))) continue;
    if (only != null && !row.label.startsWith(only)) continue;
    const role = row.stagger;
    if (role?.conditional && !holds(role.when, context)) continue;
    if (role?.sequence != null) {
      if (!role.conditional && replaced.has(role.sequence)) continue;
      // `CS1` deals its own stage; a cast whose stacks made two slashes, two.
      if (sequence != null && role.sequence !== sequence) continue;
      if (context.moves != null && role.sequence > context.moves) continue;
    }
    if (sequence != null && row.sequences && row.sequences.length >= sequence) {
      total += row.sequences[sequence - 1]?.[index] ?? 0;
    } else {
      total += row.values[index] ?? 0;
    }
  }
  return total;
}

/** The Endministrator's crystals: a debuff that a Physical Status breaks. */
const CRYSTAL = 'Originium Crystal';

/** What shatters Solidification: Vulnerable and any Physical Status. */
const PHYSICAL_STATUS = new Set(['Vulnerable', 'Lift', 'Knock Down', 'Crush', 'Breach', 'Physical Status']);

/**
 * A reaction's duration by Status Level, where the wiki gives one.
 * Solidification is «5.75 – 8.75s (based on the Status Level)»: the ends come
 * from the wiki, a second per level between them is an assumption. Unknown
 * ones are `null`, and the track draws an open window rather than an
 * invented end. `bonus` is seconds the applier adds (Arcane's Weapon Honing:
 * Corrosion +10 s).
 */
function reactionSeconds(reaction: string, level: number, bonus = 0): number | null {
  const sl = Math.min(Math.max(level, 1), 4);
  if (reaction === 'Solidification') return 5.75 + (sl - 1) + bonus;
  if (reaction === 'Combustion') return 10 + bonus;
  if (reaction === 'Electrification') return 12 + 6 * (sl - 1) + bonus;
  if (reaction === 'Corrosion') return 15 + bonus;
  return null;
}

/** Reactions currently on the target. */
function reactionsOnTarget(target: TargetState): string[] {
  return target.debuffs
    .map((debuff) => debuff.term)
    .filter((term) => classify(term).kind === 'consumesInfliction');
}

/** SP restored by a Final Strike: by operator key, then by name, then the default. */
export function finalStrikeSp(table: SpTable, key: string, name: string = key): number {
  return table.finalStrike.known[key] ?? table.finalStrike.known[name] ?? table.finalStrike.default;
}

function findSkill(operator: Operator, type: SkillType): Skill | undefined {
  return operator.skills.find((skill) => skill.type === type);
}

/**
 * Splits a rotation by variant.
 *
 * A variant is an alternative way to play the same rotation, and they
 * cannot be run back to back: each has its own start, cooldowns and fresh
 * target. Cycles within a variant, on the contrary, do run back to back —
 * the point of a second cycle is that the first one's debuffs are still up.
 */
export function splitVariants(steps: RotStep[]): Array<{ variant: string | null; steps: RotStep[] }> {
  const out: Array<{ variant: string | null; steps: RotStep[] }> = [];
  for (const step of steps) {
    const last = out[out.length - 1];
    if (!last || last.variant !== step.variant) out.push({ variant: step.variant, steps: [step] });
    else last.steps.push(step);
  }
  return out;
}

export interface SimulateOptions {
  /**
   * Multiplier on action durations. Running the same track at several scales
   * and comparing verdicts is the honest way to use unmeasured time: see
   * `timing.ts` and `simulateVariant`.
   */
  scale?: number;
  target?: Target;
  sp?: SpTable;
  synergy?: Synergy;
  /**
   * Combo Skill Priority Settings from the game: who casts first when
   * several combos trigger **at the same moment**. Missing operators follow
   * in team order, which is also the game's default.
   */
  comboPriority?: string[];
  /**
   * Seconds added to reactions an operator applies, by reaction: Arcane's
   * Weapon Honing makes his Corrosion last longer. Comes from the effects
   * layer (`EffectModifiers.reactionSeconds`), not from text.
   */
  reactionBonus?: Record<string, Record<string, number>>;
  /**
   * What potentials and gear change in the resources, by operator: combo
   * cooldown, ultimate cost, SP returned on consuming a term. From the
   * effects layer (`simModifiersFor`), not from text.
   */
  modifiers?: Record<string, SimModifiers>;
  /** The fight starts with every ultimate charged. */
  ultimatesCharged?: boolean;
  /**
   * SP never runs short: a battle skill does not wait, and the gauge is
   * back at its cap after every spend. Energy still comes from the SP spent.
   * For sketching a rotation in a vacuum (`sp: unlimited`).
   */
  unlimitedSp?: boolean;
  /**
   * The operator controlled before the first step (the rotation's
   * `controlled:` line). Missing or not in the team: `controlledAtStart`
   * decides.
   */
  controlled?: string | null;
}

/**
 * What a press holds, in seconds from it (ENGINE_CORE_PLAN.md, §3.2).
 *
 * * `input` — the skill buttons of every operator: another operator's battle
 *   skill holds them 8 client frames, an ultimate its cutscene. A combo
 *   holds nothing here: it slows the world instead (`Dilation`), and another
 *   combo may follow at once (#66). The controlled operator's attacks do not
 *   hold them.
 * * `own` — the operator's own next action.
 * * `chain` — the controlled operator's attack chain. Attacks hold it; so do
 *   a pause, a dodge and an ultimate's cutscene (#67). A battle skill holds
 *   it 8 frames only when the chain is not running: one pressed mid-chain
 *   does not delay it (#68b). A combo stops it by its slowdown (#64).
 */
export interface Holds {
  input: number;
  own: number;
  chain: number;
}

/**
 * A combo's world slowdown (measurements, #64, #66): from `from` to `until`
 * everyone but `exempt` runs at `scale` (0.05: all but standing still) —
 * another operator's chain, a combo cast before it; natural SP regen stands
 * still. A later combo cuts it short: its own slowdown takes over, and the
 * earlier caster is slowed under it.
 */
export interface Dilation {
  from: number;
  until: number;
  exempt: string;
  step: number;
  scale: number;
  /**
   * Buff and debuff timers run at `scale` too (a combo: #70, a debuff lived
   * 14.20 s through 2.43 s of slowdown against 11.93 s without). An
   * ultimate's cutscene does not slow them (#16, #35).
   */
  timers: boolean;
}

/** World time `seconds` of buff or debuff timer after `at`: the combo slowdowns stretch it (#70). */
export function timerEnd(dilations: readonly Dilation[], at: number, seconds: number): number {
  return warp(dilations.filter((span) => span.timers), at, seconds, null);
}

/**
 * World time at which `who` has run `seconds` of its own time from `start`:
 * under a slowdown it is not exempt from, its time runs at the span's
 * `scale`. The list is in time order and its spans do not overlap.
 */
export function warp(dilations: readonly Dilation[], start: number, seconds: number, who: string | null): number {
  let at = start;
  let left = seconds;
  for (const span of dilations) {
    if (span.until <= at + 1e-12 || span.exempt === who) continue;
    if (span.from >= at + left - 1e-12) break;
    if (span.from > at) {
      left -= span.from - at;
      at = span.from;
    }
    const run = (span.until - at) * span.scale;
    if (run >= left) return at + (span.scale > 0 ? left / span.scale : 0);
    left -= run;
    at = span.until;
  }
  return at + left;
}

/** The controlled operator's attacks: they run on the attack chain. */
export const CHAIN_KINDS: ReadonlySet<ActionKind> = new Set(['BA', 'FS', 'FIN', 'DIVE']);

/**
 * Who is controlled when the fight starts.
 *
 * The rotation's own choice if it names a squad member. Otherwise the first
 * operator the track shows performing a controlled action, since a player
 * rarely swaps away just to swap back; otherwise slot 01.
 */
export function controlledAtStart(
  steps: readonly RotStep[],
  team: Map<string, TeamMember>,
  chosen: string | null = null,
): string | null {
  if (chosen && team.has(chosen)) return chosen;
  const first = steps.find((step) => step.actor && team.has(step.actor) && CONTROLLED_KINDS.has(step.kind));
  if (first?.actor) return first.actor;
  return slotOrder(team).find(Boolean) ?? null;
}

export interface SimModifiers {
  /** Flat cooldown change by skill type, seconds: Chen's P5 is −3 on the combo. */
  cooldownFlat?: Partial<Record<SkillType, number>>;
  /** Fractional cooldown change: −0.15 means −15 %. */
  cooldownPct?: Partial<Record<SkillType, number>>;
  /** Fractional ultimate cost change: −0.15 means −15 %. */
  ultCostPct?: number;
  /**
   * SP returned when the operator's own skill consumes a term: the
   * Endministrator's P1 returns 50 SP when her battle skill consumes the
   * crystals. Returned, not recovered: no energy, no "on recovery" effects.
   */
  spOnConsume?: Array<{ term: string; skillType?: SkillType; sp: number }>;
  /** SP a cast of this type returns: Rossi's P1, Yvonne's P4 (`cast:Battle Skill`). */
  spOnCast?: Array<{ skillType: SkillType; sp: number }>;
  /** Reactions the member's skills apply, edited (`EffectModifiers.reactionEdits`): Laevatain's P3. */
  reactionEdits?: EffectModifiers['reactionEdits'];
  /** Edits of the operator's own Susceptibility and Amp: Lifeng's P1 condition, Mi Fu's +4 s. */
  grants?: GrantModifier[];
  /** What the build adds to the Stagger the operator deals (`staggerModifiersFor`). */
  stagger?: StaggerModifiers;
}

/**
 * The build's part in the Stagger an operator deals (measurements, #62).
 * Without a build: no efficiency, Arts Intensity 0, no effect hits.
 */
export interface StaggerModifiers {
  /** Stagger Efficiency Bonus as a fraction: Swordmancer's +20 % is 0.2. It scales every Stagger the operator deals. */
  efficiency: number;
  /** Arts Intensity: Lift and Knock Down deal `10 × (1 + AI / 200)`. */
  artsIntensity: number;
  /** Effect hits with their own Stagger: Swordmancer's «[10 Stagger]» after a Physical Status, once per 15 s. */
  hits: Array<{ name: string; on: string; cooldown: number; stagger: number }>;
}

/** Lift and Knock Down: «deal 10 Stagger by default», ×(1 + AI / 200) (wiki, `Arts Intensity`; measurements, #62). */
const STATUS_STAGGER: Record<string, number> = { Lift: 10, 'Knock Down': 10 };

/** An operator's ultimate cost, potentials included. */
export function ultimateCost(member: TeamMember, modifiers: SimModifiers = {}): number {
  const skill = findSkill(member.operator, 'Ultimate');
  const base = skill ? (statAt(skill, 'Ultimate Energy Cost', member.skills.ultimate) ?? 0) : 0;
  return base * (1 + (modifiers.ultCostPct ?? 0));
}

/**
 * Effective combo priority: the custom list first, then team order.
 *
 * The game's own wording: priority applies only to combos triggered
 * simultaneously, "not those triggered within a short period of time".
 */
export function priorityOrder(team: string[], custom: string[] = []): string[] {
  const order = custom.filter((key) => key && team.includes(key));
  for (const key of team) if (key && !order.includes(key)) order.push(key);
  return order;
}

/**
 * Runs a rotation once.
 *
 * Expects the steps of **one variant**: split them with `splitVariants`.
 * Callers that start from a bundle should use `simulateVariant`, which also
 * runs the sensitivity passes.
 *
 * A step goes through the phases below in this order, and the order is the
 * model: resources are paid before the cast (a wait moves the clock first),
 * the trigger is checked at the moment of the cast, a skill eats what stands
 * on the target before it applies its own, and time passes last.
 */
export function simulate(
  steps: RotStep[],
  team: Map<string, TeamMember>,
  timings: Timings,
  opts: SimulateOptions = {},
): SimulationResult {
  const s = newState(team, timings, opts);
  s.controlled = controlledAtStart(steps, team, opts.controlled ?? null);
  const start = s.controlled;
  const frames: Frame[] = [];

  for (const [stepIndex, step] of steps.entries()) {
    s.next = steps[stepIndex + 1] ?? null;
    const member = step.actor ? team.get(step.actor) : undefined;
    // A press waits for the input, its operator and the chain (§3.2).
    if (member) moveTo(s, pressGate(s, step));
    if (!member) {
      frames.push({
        step,
        world: s.world,
        real: s.real,
        duration: 0,
        sp: s.sp,
        energy: { ...s.energy },
        cooldowns: {},
        target: cloneTarget(s.target),
        staggeredAtStart: s.target.staggered,
        status: [],
        problems: [{ code: 'notInTeam', actor: step.actorRaw }],
        verdicts: new Map(),
        combos: [],
        applied: [],
        spRecovered: 0,
        spRecoveredBy: {},
        charges: [],
        transformed: null,
        enhancedBasic: null,
        duringUltimate: null,
        ownStacks: [],
        stock: null,
        detonated: null,
        stacksForHit: 0,
        moves: null,
        enhanced: false,
        link: null,
        links: s.links.map((link) => ({ ...link })),
        chained: false,
        controlled: s.controlled,
        holds: { input: 0, own: 0, chain: 0 },
        clientTimed: false,
      });
      continue;
    }

    if (FILLER_KINDS.has(step.kind)) {
      frames.push(filler(s, step, member));
      continue;
    }

    const c = newStep(s, step, member);
    expire(s, c);
    landInFlight(s, c);
    const staggeredAtStart = s.target.staggered;
    takeControl(s, c);
    // `CS1 > CS2` continues the same cast and does not break a block of
    // simultaneous combos; any other action does.
    if (c.step.kind !== 'CS') s.comboBlock = [];
    const duration = durationFor(s, c);

    useTransform(s, c);
    payBattleSkill(s, c);
    spendOwnStacks(s, c);
    spendStock(s, c);
    payUltimate(s, c);
    freezeRegenForCutscene(s, c);
    enterStance(s, c);
    gainCharges(s, c);
    gainTransform(s, c);
    openEnhancedBasic(s, c);
    pauseEnhancedBasic(s, c, duration);
    gainStock(s, c);
    plantFuse(s, c);
    detonate(s, c);
    spendLink(s, c);
    cutComboCooldown(s, c);
    castCombo(s, c);
    slowWorld(s, c);
    finalStrikeAndFinisher(s, c);
    buildStagger(s, c);
    swapBySlot(s, c);
    echoInflictions(s, c);
    // Every wait is behind: the press is now, and it holds the channels —
    // whether its hit lands before the next press depends on that.
    const holds = holdsFor(s, c, duration);
    hold(s, member.key, holds, c.step.kind);
    s.pressedAt.set(c.step.index, s.world);
    landBeforeOwnHit(s, c);
    c.before = cloneTarget(s.target);
    consumeOwn(s, c);
    applyOwn(s, c);
    applyEnhancedBasic(s, c);
    applyDuringUltimate(s, c);
    armStrike(s, c);
    stockLevels(s, c);
    landDeferred(s, c);
    strikeGrants(s, c);
    spendCharges(s, c);
    gainOwnStacks(s, c);
    absorbIntoStacks(s, c);
    // When the next press comes: what lands before then lands on this step.
    const until = s.next ? pressGate(s, s.next) : finishAt(s);
    // A background battle skill whose hit comes while this step plays: a
    // combo it opens is ready at the hit, not at the step's end (#63).
    const openBefore = openKeys(s);
    const landed = freezesTimers(s.timings, c.step.kind) ? null : landInFlight(s, c, until - 1e-9);
    if (c.applied.length > 0) {
      c.verdicts.set(`${c.step.index}:applies`, { code: 'applies', terms: [...new Set(c.applied)].sort() });
    }
    expireDebuffs(s, c);
    const spRecovered = recoverSp(s, c);
    returnSpOnConsume(s, c);

    frames.push({
      step: c.step,
      world: s.world,
      real: s.real,
      duration,
      sp: s.sp,
      energy: { ...s.energy },
      cooldowns: Object.fromEntries(s.readyAt),
      target: cloneTarget(s.target),
      staggeredAtStart,
      ...(c.brokenByFirstHit ? { brokenByFirstHit: true } : {}),
      status: c.status,
      problems: c.problems,
      verdicts: c.verdicts,
      combos: openCombos(s, holds.input, landed == null ? undefined : { before: openBefore, ...landed }),
      applied: c.appliedBy,
      spRecovered,
      spRecoveredBy: recoveredBy(c, spRecovered),
      charges: c.charges,
      transformed: c.transformed ? { into: c.transformed.into, as: c.transformed.as } : null,
      enhancedBasic: c.enhancedBasic ? { move: c.enhancedBasic.entry.move, skill: c.enhancedBasic.skill.name } : null,
      ownStacks: c.ownStacks,
      duringUltimate: c.duringUltimate?.move ?? null,
      stock: c.stock,
      detonated: c.detonated,
      stacksForHit:
        c.status.reduce(
          (sum, event) =>
            sum +
            (event.kind === 'consumesInfliction' || event.kind === 'consumesVulnerable' ? (event.consumed ?? 0) : 0),
          0,
        ) || c.triggerStacks,
      moves: c.moves,
      enhanced: c.enhanced,
      link: c.link,
      links: s.links.map((link) => ({ ...link })),
      chained: c.chained,
      controlled: s.controlled,
      holds,
      clientTimed: c.clientTimed,
    });
    noteControlled(s, c.step);

    // The clock moves at the next press.
  }
  // The rotation ends when the last action does.
  moveTo(s, finishAt(s));
  for (const frame of frames) frame.dilations = s.dilations;

  return {
    frames,
    spTimeline: s.spTimeline,
    world: s.world,
    real: s.real,
    waited: s.waited,
    waits: s.waits,
    regen: s.regen,
    controlled: start,
    dilations: s.dilations,
  };
}

// ------------------------------------------------------------- state

/** An application held back until the next Final Strike. */
interface Pending {
  member: TeamMember;
  skill: Skill;
  exclude: Set<string>;
  step: number;
  /** The skill's own «Duration (s)»: 15 s for Last Rite. */
  expiresAt: number;
  /**
   * World time a background battle skill's hit lands (#63). Set — the item
   * waits for that moment, not for a Final Strike.
   */
  landsAt?: number;
  /** The press the hit counts from, and its operator's own seconds to it: `landsAt` follows a later slowdown (`warp`). */
  landsFrom?: number;
  landsAfter?: number;
  /** `false` — this hit delivers only its own share; the cast's repeats ride their own hits (`ultimateHits`). */
  repeat?: boolean;
}

/** Everything that carries over from one step to the next. */
interface SimState {
  readonly team: Map<string, TeamMember>;
  /** Team positions: the first key is slot 01. */
  readonly order: string[];
  readonly priority: string[];
  readonly timings: Timings;
  readonly scale: number;
  /** The enemy as configured; `target` is its live state. */
  readonly enemy: Target;
  readonly spTable: SpTable;
  readonly regen: number;
  readonly unlimitedSp: boolean;
  readonly synergy: Synergy;
  readonly reactionBonus: Record<string, Record<string, number>>;
  readonly modifiers: Record<string, SimModifiers>;

  world: number;
  real: number;
  waited: number;
  readonly waits: Wait[];
  sp: number;
  readonly spTimeline: SpPoint[];
  readonly energy: Record<string, number>;
  /** "operator:skill type" → world time the skill is available again. */
  readonly readyAt: Map<string, number>;
  readonly target: TargetState;
  /** Link buffs on the team: each with its own duration, all spent by the next BS or ULT. */
  links: Debuff[];
  /** Step of the latest Final Strike (`FS`), Finisher (`FIN`) and combo of each operator (`CS:<key>`): action triggers open on them. */
  readonly strikes: Map<string, number>;
  /**
   * When a Final Strike's hit lands, by its step: an action trigger opens on
   * the hit, not on the press (`chainHits`, ENGINE_CORE_PLAN.md Я3).
   */
  readonly strikeHits: Map<number, { at: number; actor: string; from: number; after: number }>;
  /** When a combo's first hit lands, by its step: a combo opened by another combo lights up on it (#66). */
  readonly comboHits: Map<number, { at: number; actor: string; from: number; after: number }>;
  /** Combo slowdowns so far, in time order (`Dilation`). */
  readonly dilations: Dilation[];
  /** World time of each step's press. */
  readonly pressedAt: Map<number, number>;
  /** World time each term was last put on the target: when a combo it opens lit up (#65). */
  readonly latestAt: Map<string, { at: number; step: number }>;
  /** While a cast delivers at its press: the moment its hit lands, for `latestAt`. */
  noteAt: number | null;
  /** World time until which natural SP regen is paused (a perfect dodge). */
  regenPausedUntil: number;
  /** SP a hit recovers when it lands, still ahead of the clock (`recoverOnLanding`); `advance` credits it. */
  spLater: Array<{ at: number; sp: number }>;
  /** The step after the current one: a battle skill holds its own operator longer than the others. */
  next: RotStep | null;
  /** The latest action of the controlled operator: a `BA` here lets an `FS` finish its chain. */
  lastControlled: RotStep | null;
  /** The operator under control right now. */
  controlled: string | null;

  /** Terms on the target, by the step that FIRST provided them: is a combo open at all. */
  readonly provided: Provided;
  /** The same by the LATEST application: what opened a combo just now. */
  readonly latest: Provided;
  /** Step at which a term's stacks were last consumed, and how many. */
  readonly consumedAt: Provided;
  readonly consumedCount: Map<string, number>;
  /** Terms ever put on the target as a timed debuff: their presence is known. */
  readonly debuffTerms: Set<string>;
  /** `operator:stance` → world time the stance ends. */
  readonly stances: Map<string, number>;
  /** What an operator's skill left on the field (`Synergy.stocks`): when each runs out. */
  readonly stocks: Map<string, number[]>;
  /** Operators whose next basic attack is a Final Strike (`Synergy.strikeAfter`). */
  readonly strikeReady: Set<string>;
  /** A charge stuck on the target, by operator (`Synergy.detonates`): until its own explosion. */
  readonly fuses: Map<string, { skill: string; until: number; step: number }>;
  /** A battle skill turned into another move, by operator, until when (`Synergy.transforms`). */
  readonly transformed: Map<string, { entry: TransformEntry; until: number | null }>;
  /** An operator's own stacks (`Synergy.ownStacks`): Laevatain's Melting Flame. */
  readonly ownStacks: Map<string, number>;
  /** An ultimate's enhanced basic attack, by operator, until when (`Skill.enhancedBasic`). */
  readonly enhancedBasic: Map<string, { entry: SkillEnhancedBasic; skill: Skill; until: number }>;
  /** Points a cast generated and other steps spend, by owner (`Synergy.charges`). */
  readonly charges: Map<string, { skill: Skill; level: number; entry: ChargeEntry; left: number; until: number | null; step: number }>;
  /** Effect hits with Stagger (`StaggerModifiers.hits`): when each may fire again, by `operator:name`. */
  readonly hitReadyAt: Map<string, number>;
  /** Until when an operator's two-phase ultimate is in its first phase (Arcane's array). */
  readonly switchedUntil: Map<string, number>;
  /** Step of each operator's latest combo: a «consumed» trigger opens a combo once. */
  readonly lastCast: Map<string, number>;
  /** When each element's infliction runs out: 20 s after its latest stack. */
  readonly inflictionUntil: Partial<Record<ArtsElement, number>>;
  pending: Pending[];
  armed: ArmedGrant[];
  /** Combos written back to back: candidates for "triggered simultaneously". */
  comboBlock: Array<{ key: string; index: number; openedAt: number }>;

  /** World time the skill buttons are free again (`Holds.input`). */
  inputFreeAt: number;
  /** World time the controlled operator's chain is free again (`Holds.chain`). */
  chainFreeAt: number;
  /** World time each operator is free again (`Holds.own`). */
  readonly ownFreeAt: Map<string, number>;
  /** What set `ownFreeAt`: the press and the operator's own seconds, so a later slowdown moves it. */
  readonly ownBusy: Map<string, { start: number; seconds: number }>;
  /** What set the chain's end by an attack: its press, own seconds and operator. */
  chainBusy: { start: number; seconds: number; who: string } | null;
  /** The chain held by other presses (a cutscene, a pause): world time, slowdowns do not move it. */
  chainHeldUntil: number;
}

/** Keys by team position: `order[0]` is slot 01, an empty slot is `''`. */
export function slotOrder(team: Map<string, TeamMember>): string[] {
  const order: string[] = [];
  [...team.values()].forEach((member, index) => {
    order[(member.slot ?? index + 1) - 1] = member.key;
  });
  return Array.from(order, (key) => key ?? '');
}

function newState(team: Map<string, TeamMember>, timings: Timings, opts: SimulateOptions): SimState {
  const spTable = opts.sp ?? FALLBACK_SP;
  const order = slotOrder(team);
  const modifiers = opts.modifiers ?? {};
  const energy: Record<string, number> = {};
  for (const member of team.values()) {
    energy[member.key] = opts.ultimatesCharged ? ultimateCost(member, modifiers[member.key]) : 0;
  }
  return {
    team,
    order,
    priority: priorityOrder(order, opts.comboPriority),
    timings,
    scale: opts.scale ?? 1,
    enemy: opts.target ?? DUMMY,
    spTable,
    regen: spTable.passiveRegen ?? SP_REGEN_PER_SECOND,
    unlimitedSp: opts.unlimitedSp ?? false,
    synergy: opts.synergy ?? EMPTY_SYNERGY,
    reactionBonus: opts.reactionBonus ?? {},
    modifiers,
    world: 0,
    real: 0,
    waited: 0,
    waits: [],
    sp: SP_CAP,
    spTimeline: [{ t: 0, sp: SP_CAP }],
    energy,
    readyAt: new Map(),
    target: {
      vulnerable: 0,
      inflictions: { Heat: 0, Cryo: 0, Electric: 0, Nature: 0 },
      debuffs: [],
      staggered: false,
      stagger: 0,
      staggeredUntil: 0,
      marks: [],
    },
    links: [],
    strikes: new Map(),
    strikeHits: new Map(),
    comboHits: new Map(),
    dilations: [],
    pressedAt: new Map(),
    latestAt: new Map(),
    noteAt: null,
    regenPausedUntil: 0,
    spLater: [],
    next: null,
    lastControlled: null,
    controlled: null,
    provided: new Map(),
    latest: new Map(),
    consumedAt: new Map(),
    consumedCount: new Map(),
    debuffTerms: new Set(),
    stances: new Map(),
    charges: new Map(),
    hitReadyAt: new Map(),
    transformed: new Map(),
    enhancedBasic: new Map(),
    ownStacks: new Map(),
    stocks: new Map(),
    fuses: new Map(),
    strikeReady: new Set(),
    switchedUntil: new Map(),
    lastCast: new Map(),
    inflictionUntil: {},
    pending: [],
    armed: [],
    comboBlock: [],
    inputFreeAt: 0,
    chainFreeAt: 0,
    ownFreeAt: new Map(),
    ownBusy: new Map(),
    chainBusy: null,
    chainHeldUntil: 0,
  };
}

// ------------------------------------------------------------- presses

/**
 * The earliest moment `step` may be pressed (ENGINE_CORE_PLAN.md, §3.2): not
 * before the press before it, and
 *
 * * a skill — once the skill buttons and its operator are free;
 * * an attack of the controlled operator — once the chain and the operator
 *   are free; a swap to another operator also waits for the skill buttons;
 * * a pause or a dodge — once everything the player was doing is over.
 *
 * Resources, cooldowns and triggers are not here: the cast waits for them
 * itself (`wait`), as before.
 */
function pressGate(s: SimState, step: RotStep): number {
  const own = step.actor ? (s.ownFreeAt.get(step.actor) ?? 0) : 0;
  if (FILLER_KINDS.has(step.kind)) return thaw(s, Math.max(s.world, s.inputFreeAt, s.chainFreeAt, own), null);
  if (CHAIN_KINDS.has(step.kind)) {
    const swap = step.actor !== s.controlled;
    return thaw(s, Math.max(s.world, s.chainFreeAt, own, swap ? s.inputFreeAt : 0), step.actor);
  }
  // A combo may be pressed while another one slows the world (#66).
  if (step.kind === 'CS') return Math.max(s.world, s.inputFreeAt, own);
  return thaw(s, Math.max(s.world, s.inputFreeAt, own), step.actor);
}

/**
 * A press of anything but a combo while a slowdown runs: it is taken, and
 * its action crawls at the span's scale until the span ends — the same as
 * starting that much before the end. Another operator's battle skill spammed
 * from the Endministrator's combo came 25 ± 1 frames in (#35): 0.867 × 0.95.
 */
function thaw(s: SimState, at: number, who: string | null): number {
  let out = at;
  for (const span of s.dilations) {
    if (span.exempt !== who && span.from <= out + 1e-9 && out < span.until - 1e-9) {
      out = span.until - (span.until - out) * span.scale;
    }
  }
  return out;
}

/** When the last action is over: the rotation's end. */
function finishAt(s: SimState): number {
  return Math.max(s.world, s.inputFreeAt, s.chainFreeAt, ...s.ownFreeAt.values());
}

/** World and real time move to `at`: SP regenerates on the way. */
function moveTo(s: SimState, at: number): void {
  const gap = at - s.world;
  if (gap <= 1e-12) return;
  s.real += gap;
  advance(s, gap);
}

/**
 * What a press holds (`Holds`). `duration` is how long its operator is busy:
 * a battle skill's own window, a combo's, an ultimate's cutscene, a chain
 * segment.
 */
function holdsFor(s: SimState, c: StepContext, duration: number): Holds {
  const { kind } = c.step;
  if (CHAIN_KINDS.has(kind)) return { input: 0, own: duration, chain: duration };
  if (kind === 'BS') {
    // Another operator may act 8 client frames in (#35, Chen → Pogranichnik).
    const window = c.transformed ? undefined : windowsOf(s, c.member)?.BS;
    const other = window?.other != null ? Math.min(window.other, duration) : duration;
    // The chain does not wait for it at all: one running goes on (#68b: the
    // Endministrator's chain to the Final Strike took 3.383 s with Lifeng's
    // battle skill in the middle and without), and one started right after
    // it hit 0.30 s after his press, where 8 frames would make it 0.47 (#71).
    return { input: other, own: duration, chain: 0 };
  }
  // A combo slows the world instead of holding the buttons (`slowWorld`):
  // another combo may follow at once (#66). Without the client's slowdown,
  // its window holds the buttons, as before.
  if (kind === 'CS') {
    const slows = !c.transformed && windowsOf(s, c.member)?.CS?.dilation;
    return { input: slows ? 0 : duration, own: duration, chain: 0 };
  }
  // An ultimate's cutscene stops the chain by its span (`freezeRegenForCutscene`), mid-segment too (#67).
  if (kind === 'ULT' && c.verdicts.has(`${c.step.index}:cutscene`)) return { input: duration, own: duration, chain: 0 };
  return { input: duration, own: duration, chain: duration };
}

/**
 * The press at `s.world` holds the channels. An operator's own time and its
 * attacks run in its own time: a later combo's slowdown moves them
 * (`rewarp`); the buttons and the chain held by a cutscene do not move.
 */
function hold(s: SimState, key: string, holds: Holds, kind: ActionKind): void {
  s.inputFreeAt = Math.max(s.inputFreeAt, s.world + holds.input);
  const own = warp(s.dilations, s.world, holds.own, key);
  if (own > (s.ownFreeAt.get(key) ?? 0)) {
    s.ownFreeAt.set(key, own);
    s.ownBusy.set(key, { start: s.world, seconds: holds.own });
  }
  if (CHAIN_KINDS.has(kind)) {
    const chain = warp(s.dilations, s.world, holds.chain, key);
    if (!s.chainBusy || chain > warp(s.dilations, s.chainBusy.start, s.chainBusy.seconds, s.chainBusy.who)) {
      s.chainBusy = { start: s.world, seconds: holds.chain, who: key };
    }
  } else {
    s.chainHeldUntil = Math.max(s.chainHeldUntil, s.world + holds.chain);
  }
  s.chainFreeAt = chainEnd(s);
}

function chainEnd(s: SimState): number {
  const busy = s.chainBusy ? warp(s.dilations, s.chainBusy.start, s.chainBusy.seconds, s.chainBusy.who) : 0;
  return Math.max(s.chainHeldUntil, busy);
}

/**
 * A combo's slowdown (measurements, #64, #66): from its press the world
 * runs at `comboTimeScale` for everyone but its caster for the client's
 * `dilation` seconds. A slowdown still running ends here — the new one takes over.
 * Whoever is busy is busy that much longer, a hit still on its way comes that
 * much later, and natural SP regen stands still (`advance`).
 */
function slowWorld(s: SimState, c: StepContext): void {
  if (c.step.kind !== 'CS' || c.transformed || (c.step.sequence != null && c.step.sequence > 1)) return;
  const seconds = windowsOf(s, c.member)?.CS?.dilation;
  if (!seconds) return;
  cutSlowdown(s);
  const scale = s.timings.comboTimeScale ?? 0;
  s.dilations.push({ from: s.world, until: s.world + seconds, exempt: c.member.key, step: c.step.index, scale, timers: true });
  retime(s, stretch(s.world, seconds, scale));
  rewarp(s);
  markSp(s);
  c.verdicts.set(`${c.step.index}:slows`, { code: 'comboSlowsWorld', seconds });
}

/** World time `seconds` of timer from now, under the slowdowns already running (#70). */
function tEnd(s: SimState, seconds: number): number {
  return timerEnd(s.dilations, s.world, seconds);
}

/**
 * Every running buff and debuff timer, re-read through `map`: a slowdown
 * that starts now stretches what is still running, one cut short now gives
 * the rest back (#70). Cooldowns are not timers here: they tick unscaled
 * (`useTimeScaleForSkillCdTick: false`, sp.yaml).
 */
function retime(s: SimState, map: (end: number) => number): void {
  const live = (end: number) => (Number.isFinite(end) && end > s.world ? map(end) : end);
  for (const debuff of s.target.debuffs) if (debuff.expiresAt != null) debuff.expiresAt = live(debuff.expiresAt);
  for (const mark of s.target.marks) mark.expiresAt = live(mark.expiresAt);
  if (s.target.staggered) s.target.staggeredUntil = live(s.target.staggeredUntil);
  for (const link of s.links) if (link.expiresAt != null) link.expiresAt = live(link.expiresAt);
  for (const element of INFLICTION_ELEMENTS) {
    const until = s.inflictionUntil[element];
    if (until !== undefined) s.inflictionUntil[element] = live(until);
  }
  for (const [key, until] of s.stances) s.stances.set(key, live(until));
  for (const [key, until] of s.switchedUntil) s.switchedUntil.set(key, live(until));
  for (const window of s.enhancedBasic.values()) window.until = live(window.until);
  for (const window of s.transformed.values()) if (window.until != null) window.until = live(window.until);
  for (const charge of s.charges.values()) if (charge.until != null) charge.until = live(charge.until);
  for (const fuse of s.fuses.values()) fuse.until = live(fuse.until);
  for (const [key, ends] of s.stocks) s.stocks.set(key, ends.map(live));
  for (const item of s.pending) item.expiresAt = live(item.expiresAt);
  for (const item of s.armed) item.until = live(item.until);
}

/** A timer slowdown `[from, from + length)` at `scale` starts: stretch what runs through it. */
function stretch(from: number, length: number, scale: number): (end: number) => number {
  return (end) => (end - from <= length * scale ? from + (scale > 0 ? (end - from) / scale : length) : end + length * (1 - scale));
}

/** The same slowdown taken back. */
function unstretch(from: number, length: number, scale: number): (end: number) => number {
  return (end) => (end < from + length ? from + (end - from) * scale : end - length * (1 - scale));
}

/** The running slowdown ends now: a new one takes over (#66), and timers get its rest back. */
function cutSlowdown(s: SimState): void {
  const last = s.dilations.at(-1);
  if (!last || last.until <= s.world) return;
  if (last.timers) retime(s, unstretch(s.world, last.until - s.world, last.scale));
  last.until = s.world;
}

/** Everything that runs in an operator's own time, moved by the slowdowns so far. */
function rewarp(s: SimState): void {
  for (const [key, busy] of s.ownBusy) s.ownFreeAt.set(key, warp(s.dilations, busy.start, busy.seconds, key));
  s.chainFreeAt = chainEnd(s);
  for (const item of s.pending) {
    if (item.landsFrom != null && item.landsAfter != null) {
      item.landsAt = warp(s.dilations, item.landsFrom, item.landsAfter, item.member.key);
    }
  }
  for (const hit of [...s.strikeHits.values(), ...s.comboHits.values()]) hit.at = warp(s.dilations, hit.from, hit.after, hit.actor);
}

/** Until when natural SP regen stands still at `at`: a perfect dodge, a cutscene, a combo's slowdown; `null` — it runs. */
function regenPausedAt(s: SimState, at: number): number | null {
  let until = s.regenPausedUntil > at + 1e-9 ? s.regenPausedUntil : null;
  for (const span of s.dilations) {
    if (span.from <= at + 1e-9 && at < span.until - 1e-9) until = Math.max(until ?? 0, span.until);
  }
  return until;
}

/** An operator's skill hits from the client (`SpTable.basicAttack`). */
function windowsHits(s: SimState, member: TeamMember): Partial<Record<'BS' | 'CS' | 'ULT', SkillHit[]>> | undefined {
  return (s.spTable.basicAttack?.[member.key] ?? s.spTable.basicAttack?.[member.operator.name])?.skillHits;
}

/** An operator's skill windows from the client (`SpTable.basicAttack`). */
function windowsOf(s: SimState, member: TeamMember): Partial<Record<'BS' | 'CS' | 'ULT', SkillWindow>> | undefined {
  return (s.spTable.basicAttack?.[member.key] ?? s.spTable.basicAttack?.[member.operator.name])?.skillWindows;
}

/** What one step knows about itself while it runs. */
interface StepContext {
  step: RotStep;
  readonly member: TeamMember;
  readonly skill: Skill | undefined;
  readonly skillType: SkillType;
  readonly level: number;
  /** Second cast of a two-phase ultimate: costs no energy, repeats no «when created». */
  readonly secondPhase: boolean;
  readonly slotRules: TeamPositionRule[];
  readonly problems: Message[];
  readonly verdicts: Map<string, Message>;
  /** Stacks a «stacks consumed» trigger brought into this combo's per-stack rows. */
  triggerStacks: number;
  /** `Frame.brokenByFirstHit`. */
  brokenByFirstHit?: boolean;
  /** Sequences the cast performs when the stacks decide it (`Skill.moves`). */
  moves: number | null;
  enhanced: boolean;
  link: Frame['link'];
  /** `Frame.chained`: this FS is the last hit of the BA before it. */
  readonly chained: boolean;
  readonly status: StatusEvent[];
  /** Terms the step applied, and who applied each. */
  readonly applied: string[];
  readonly appliedBy: Frame['applied'];
  readonly charges: Frame['charges'];
  /** SP that hits landing inside this step recovered for their casters (`recoverOnLanding`). */
  readonly landedSp: Record<string, number>;
  /** This battle skill is a move an ultimate turned it into: Hunter Pursuit. */
  transformed: TransformEntry | null;
  /** This cast spent the operator's own stacks (`Synergy.ownStacks`). */
  spentOwn: boolean;
  readonly ownStacks: Frame['ownStacks'];
  /** This basic attack is the ultimate's enhanced chain: Laevatain's. */
  readonly enhancedBasic: { entry: SkillEnhancedBasic; skill: Skill } | null;
  /** This battle skill is the one the ultimate's window swaps in, with the ultimate. */
  readonly duringUltimate: (NonNullable<Skill['duringUltimate']> & { ultimateSkill: Skill }) | null;
  stock: Frame['stock'];
  detonated: Frame['detonated'];
  /** Terms the team slot rules this skill out of applying (Si's Heat or Cryo). */
  readonly exclude: Set<string>;
  /** The target as the cast lands, before it consumes anything: «If the target has Corrosion» reads it. */
  before: TargetState | null;
  /** `Frame.clientTimed`, set by `durationFor`. */
  clientTimed: boolean;
}

function newStep(s: SimState, given: RotStep, member: TeamMember): StepContext {
  let step = given;
  const problems: Message[] = [];
  const verdicts = new Map<string, Message>();
  const filler = FILLER_KINDS.has(step.kind);
  // A filler has no skill; its "skill type" only picks a level nobody reads.
  const skillType = filler ? 'Basic Attack' : KIND_TO_SKILL[step.kind as SkillAction];
  const skill = filler ? undefined : findSkill(member.operator, skillType);

  // `BS1` on a skill whose stages are hits of one press (Lifeng, Pogranichnik)
  // means the press: older drafts offered such stages. Played as the whole
  // cast, and said so, rather than as a third of it.
  if (skill && step.sequence != null && skillType !== 'Basic Attack' && !stagesArePresses(skill)) {
    verdicts.set(`${step.index}:stages`, { code: 'stagesAreHits', written: step.sequence });
    step = { ...step, sequence: null };
  }

  // Two-phase ultimate: the next ULT within the window is the second phase.
  let secondPhase = false;
  if (skill?.switch && step.kind === 'ULT') {
    secondPhase = step.sequence != null ? step.sequence >= 2 : (s.switchedUntil.get(member.key) ?? -1) > s.world;
    if (step.sequence == null) step = { ...step, sequence: secondPhase ? 2 : 1 };
    if (secondPhase) {
      s.switchedUntil.delete(member.key);
      verdicts.set(`${step.index}:phase`, { code: 'secondPhase', to: skill.switch.to });
    } else if (skill.switch.window != null) {
      s.switchedUntil.set(member.key, s.world + skill.switch.window);
    }
  }
  if (!skill && !filler) problems.push({ code: 'noSkill', operator: member.key, skill: skillType });

  // «The next basic attack becomes a Final Strike»: one hit, whatever was written.
  let struck = false;
  if (s.strikeReady.has(member.key) && (step.kind === 'BA' || step.kind === 'FS') && step.sequence == null) {
    s.strikeReady.delete(member.key);
    struck = true;
    if (step.kind === 'BA') step = { ...step, kind: 'FS' };
    verdicts.set(`${step.index}:strikeAfter`, { code: 'strikeAfter', talent: s.synergy.strikeAfter![member.key]!.talent });
  }

  // Inside the window of an ultimate that enhances the basic attack, `BA` and
  // `FS` are its chain. A finisher and a dive attack stay her own.
  const window = s.enhancedBasic.get(member.key);
  if (window && s.world >= window.until) s.enhancedBasic.delete(member.key);
  const enhancedBasic =
    window && s.world < window.until && (step.kind === 'BA' || step.kind === 'FS')
      ? { entry: window.entry, skill: window.skill }
      : null;
  if (enhancedBasic) verdicts.set(`${step.index}:enhancedBasic`, { code: 'enhancedBasicCast', move: enhancedBasic.entry.move });
  // The battle skill in the same window is the one the ultimate swaps in.
  const swapped = skill?.duringUltimate;
  const duringUltimate =
    swapped && window && s.world < window.until && step.kind === 'BS' && window.skill.name === swapped.ultimate
      ? { ...swapped, ultimateSkill: window.skill }
      : null;
  if (duringUltimate) verdicts.set(`${step.index}:duringUltimate`, { code: 'duringUltimateCast', ultimate: swapped!.ultimate });

  return {
    step,
    member,
    skill,
    skillType,
    level: member.skills[SKILL_FIELD[skillType]] ?? 1,
    secondPhase,
    slotRules: s.synergy.teamPosition?.[member.key] ?? [],
    problems,
    verdicts,
    triggerStacks: 0,
    moves: null,
    enhanced: false,
    link: null,
    chained: struck || chainedStrike(s, step),
    status: [],
    applied: [],
    appliedBy: [],
    charges: [],
    landedSp: {},
    transformed: null,
    spentOwn: false,
    ownStacks: [],
    enhancedBasic,
    duringUltimate,
    stock: null,
    detonated: null,
    exclude: new Set(),
    before: null,
    clientTimed: false,
  };
}

/**
 * Actions of the controlled operator. They break a basic chain: a dodge
 * restarts it, a pause lets it lapse, another operator's attack means
 * control moved. Skills are cast from the controlled operator and do not
 * count — whether one resets the chain is not in the data (measurements,
 * #42).
 */
export const CONTROLLED_KINDS: ReadonlySet<ActionKind> = new Set(['BA', 'FS', 'FIN', 'DIVE', 'DODGE', 'WAIT']);

/** `BA > FS`: the Final Strike continues the chain the BA walked, rather than walking it again. */
function chainedStrike(s: SimState, step: RotStep): boolean {
  const before = s.lastControlled;
  return (
    step.kind === 'FS' &&
    step.sequence == null &&
    before?.kind === 'BA' &&
    before.sequence == null &&
    before.actor === step.actor
  );
}

function noteControlled(s: SimState, step: RotStep): void {
  // A dodge by the same operator keeps her chain: the client's dodge window
  // leads into the NEXT hit (`attack1`…`attack5`), and a dash on the Final
  // Strike's wind-up keeps it (measurements, #42). Running — a pause — resets it.
  if (step.kind === 'DODGE' && s.lastControlled?.actor === step.actor) return;
  if (CONTROLLED_KINDS.has(step.kind)) s.lastControlled = step;
}

/**
 * Control moves to whoever performs a controlled action, and to the caster
 * of a skill that says so: «Laevatain … becomes the controlled operator»
 * (`synergy.takesControl`, read in `synergy.py`). Another operator's skill
 * is cast without taking control.
 */
function takeControl(s: SimState, c: StepContext): void {
  const { step, member, skill } = c;
  const takes = skill != null && (s.synergy.takesControl?.[member.key] ?? []).includes(skill.name);
  if (CONTROLLED_KINDS.has(step.kind) || takes) s.controlled = member.key;
}

/** Records an SP point, only if it changes something. */
function markSp(s: SimState): void {
  const paused = regenPausedAt(s, s.world) != null;
  const last = s.spTimeline[s.spTimeline.length - 1];
  if (last && Math.abs(last.t - s.world) < 1e-9 && Math.abs(last.sp - s.sp) < 1e-9 && Boolean(last.paused) === paused) {
    return;
  }
  s.spTimeline.push(paused ? { t: s.world, sp: s.sp, paused } : { t: s.world, sp: s.sp });
}

/**
 * World time passes: SP regenerates, except while a perfect dodge holds it.
 * The pause gets its own SP points, so the timeline stays "regen between
 * points" and `spAt` can read it.
 */
function advance(s: SimState, seconds: number): void {
  const end = s.world + seconds;
  creditLater(s);
  while (s.world < end - 1e-12) {
    // A hit's recovery due on the way splits the segment, so it lands on time.
    const due = Math.min(end, ...s.spLater.map((item) => item.at).filter((at) => at > s.world + 1e-12));
    const paused = regenPausedAt(s, s.world);
    if (paused != null) {
      s.world = Math.min(due, paused);
      markSp(s);
      creditLater(s);
      continue;
    }
    // Regen runs up to the next slowdown, if one starts before `end`.
    const next = Math.min(due, ...s.dilations.filter((span) => span.from > s.world + 1e-12).map((span) => span.from));
    s.sp = Math.min(SP_CAP, s.sp + (next - s.world) * s.regen);
    s.world = next;
    markSp(s);
    creditLater(s);
  }
}

/** Credits the recoveries whose hits have landed by now. */
function creditLater(s: SimState): void {
  const due = s.spLater.filter((item) => item.at <= s.world + 1e-9);
  if (due.length === 0) return;
  s.spLater = s.spLater.filter((item) => !due.includes(item));
  for (const item of due) s.sp = Math.min(SP_CAP, s.sp + item.sp);
  markSp(s);
}

/**
 * An ultimate's cutscene holds natural SP regen: the stage clock and combo
 * cooldowns run through it, the SP gauge does not move, and a battle skill
 * pressed after it waits for the gauge (measurements, #35, run L5).
 */
function freezeRegenForCutscene(s: SimState, c: StepContext): void {
  if (c.step.kind !== 'ULT') return;
  const basic = s.spTable.basicAttack?.[c.member.key] ?? s.spTable.basicAttack?.[c.member.operator.name];
  const cutscene = basic?.skillWindows?.ULT?.cutscene;
  if (cutscene == null) return;
  s.regenPausedUntil = Math.max(s.regenPausedUntil, s.world + cutscene);
  // The point at the press was written before the pause: without a paused
  // point here the track reads regen through the cutscene, and the bar falls
  // back when the ultimate ends.
  markSp(s);
  c.verdicts.set(`${c.step.index}:cutscene`, { code: 'cutsceneRegen', seconds: cutscene });
  // Everyone else stands still through it (#67): the controlled chain stopped
  // between two segments and went on after it.
  cutSlowdown(s);
  s.dilations.push({ from: s.world, until: s.world + cutscene, exempt: c.member.key, step: c.step.index, scale: 0, timers: false });
  rewarp(s);
}

/** Seconds until SP reaches `cost`, counting a pause in the regen. */
function secondsToSp(s: SimState, cost: number): number {
  return (cost - s.sp) / s.regen + Math.max(0, (regenPausedAt(s, s.world) ?? s.world) - s.world);
}

/**
 * Waits `seconds` before the cast: SP regenerates, and whatever runs out
 * with time runs out. The `.rot` notation records the order of meaningful
 * actions, not every press, so a cooldown or missing SP is not an error but
 * a source of time — the engine waits exactly as long as the data says.
 */
function wait(s: SimState, c: StepContext, seconds: number, reason: string): void {
  s.waited += seconds;
  s.real += seconds;
  advance(s, seconds);
  s.waits.push({ step: c.step.index, seconds, reason });
  expire(s, c);
  landInFlight(s, c);
}

/**
 * Everything that runs out with world time. Called at the start of the step
 * and again after every wait: a cast that waited sees the target as it is
 * after the wait, not before it.
 */
function expire(s: SimState, c: StepContext): void {
  const { target } = s;
  // A deferred application that saw no Final Strike in time is lost.
  s.pending = s.pending.filter((item) => {
    if (item.expiresAt > s.world) return true;
    c.problems.push({ code: 'deferredExpired', operator: item.member.key, skill: item.skill.name, step: item.step });
    return false;
  });

  // An infliction lasts 20 s from its latest stack (wiki, Arts Infliction).
  for (const element of INFLICTION_ELEMENTS) {
    const until = s.inflictionUntil[element];
    if (until !== undefined && until <= s.world && target.inflictions[element] > 0) {
      target.inflictions[element] = 0;
      c.verdicts.set(`${c.step.index}:expired:${element}`, { code: 'inflictionExpired', element });
    }
  }

  target.debuffs = target.debuffs.filter((debuff) => debuff.expiresAt == null || debuff.expiresAt > s.world);
  s.links = s.links.filter((link) => link.expiresAt == null || link.expiresAt > s.world);

  if (target.staggered && s.world >= target.staggeredUntil) {
    target.staggered = false;
    target.stagger = 0;
  }
}

/**
 * How long the action takes. Basic attacks are the one action with a known
 * length: the period of the chain from the client's frame timeline, i.e. how
 * long after the first hit the next action can start (measurements, #35). A known
 * length is not scaled by the sensitivity passes — it is right as it is. One
 * the model is unsure of is scaled like any unmeasured duration.
 *
 * `BA > FS` is one chain: `BA` the hits up to the Final Strike, `FS` the last
 * hit. A Final Strike with no BA before it walks the whole chain to get there.
 */
function durationFor(s: SimState, c: StepContext): number {
  const { member, step } = c;
  // The enhanced chain has its own period, from the same client frames.
  const basic = c.enhancedBasic
    ? c.enhancedBasic.entry
    : (s.spTable.basicAttack?.[member.key] ?? s.spTable.basicAttack?.[member.operator.name]);
  const sequence = basic?.sequenceSeconds;
  // A barrage ultimate is its whole window, from the client's frames: a known length.
  if (step.kind === 'ULT' && c.skill?.barrage) {
    c.verdicts.set(`${step.index}:barrage`, { code: 'barrage', shots: c.skill.barrage.shots, seconds: c.skill.barrage.seconds });
    c.clientTimed = true;
    return c.skill.barrage.seconds;
  }
  // Battle skill, combo and ultimate: until the operator may act again, from
  // the client's frames (measurements, #35). Measured on the Endministrator
  // and Chen; for the rest it is the same reading.
  const own = s.spTable.basicAttack?.[member.key] ?? s.spTable.basicAttack?.[member.operator.name];
  const kind = step.kind === 'CS' || step.kind === 'ULT' || step.kind === 'BS' ? step.kind : null;
  const window = kind && !c.transformed ? own?.skillWindows?.[kind] : undefined;
  if (kind && window && !(kind === 'ULT' && c.skill?.barrage)) {
    // A battle skill holds only its own operator: another one may act
    // almost at once (#35, Chen → Pogranichnik). That is `Holds.input`; the
    // step is the operator's whole window.
    const { seconds } = window;
    c.verdicts.set(`${step.index}:window`, { code: 'skillWindow', kind, seconds, measured: window.measured === true });
    c.clientTimed = true;
    // Only the unknown is scaled (§3.6): a window read from the client's
    // frames is what the client says.
    return seconds;
  }
  // A dive: the measured fall and the client's landing (#21). Not scaled.
  const plunge = step.kind === 'DIVE' && !c.enhancedBasic ? basic && 'dive' in basic ? basic.dive : undefined : undefined;
  if (plunge) {
    c.clientTimed = true;
    return plunge.seconds;
  }
  // A finisher: the client's frames, read as on Chen's video (#21). Not scaled.
  const strike = step.kind === 'FIN' && !c.enhancedBasic ? basic && 'finisher' in basic ? basic.finisher : undefined : undefined;
  if (strike) {
    c.clientTimed = true;
    return strike.seconds;
  }
  if (sequence == null || (step.kind !== 'FS' && step.kind !== 'BA')) {
    return durationOf(s.timings, step.kind, member.key, c.skillType, s.scale);
  }
  const last = basic?.finalStrikeSeconds;
  c.clientTimed = !c.enhancedBasic;
  let seconds = sequence;
  if (last != null && step.sequence == null) {
    if (step.kind === 'BA') seconds = sequence - last;
    else if (c.chained) seconds = last;
  }
  return seconds * (basic && 'uncertain' in basic && basic.uncertain ? s.scale : 1);
}

/**
 * Seconds until a battle skill's statuses land, when that is after the step
 * ends: another operator acts while its hit is still coming (#63). Lifeng's
 * Knock Down comes 2 s after the cast, while the Endministrator is already
 * swinging. `null` — the statuses land with the cast, as before.
 */
function landsAfterStep(s: SimState, c: StepContext): number | null {
  if (c.step.kind !== 'BS' || c.transformed || c.secondPhase) return null;
  const own = s.spTable.basicAttack?.[c.member.key] ?? s.spTable.basicAttack?.[c.member.operator.name];
  const window = own?.skillWindows?.BS;
  if (window?.lands == null || window.other == null) return null;
  const lands = landsIn(window);
  // In flight when the next press comes before the hit. Otherwise nothing
  // happens between them, and the statuses land with the cast.
  return s.next && pressGate(s, s.next) < s.world + lands - 1e-9 ? lands : null;
}

/**
 * Before a battle skill takes and puts anything, what lands before its own
 * hit does: Chen's Lift, 0.43 s after her cast, comes before the Breach of
 * Pogranichnik's battle skill pressed 0.27 s after it — his hit is 1.42 s
 * after his press (#63). Its own consumption still happens at the cast.
 */
function landBeforeOwnHit(s: SimState, c: StepContext): void {
  if (c.step.kind !== 'BS' || c.transformed) return;
  const own = s.spTable.basicAttack?.[c.member.key] ?? s.spTable.basicAttack?.[c.member.operator.name];
  const window = own?.skillWindows?.BS;
  if (window?.lands == null) return;
  landInFlight(s, c, s.world + landsIn(window));
}

/**
 * Seconds to a battle skill's hit. Never scaled: it and the window are
 * frames of one client timeline, and scaling one and not the other moved a
 * hit across the next press (`bd095a2`).
 */
function landsIn(window: SkillWindow): number {
  return window.lands!;
}

/**
 * Background battle skills whose hit lands by `horizon`: they deliver on the
 * step that is running then (#63), stamped with the hit's own time — a
 * debuff runs from the hit, not from the step. Called at the start of a
 * step and after every wait; before a battle skill's own effects, up to its
 * hit (a hit that comes first lands first); and at the end of a step, up to
 * its end. Returns the latest hit delivered, or `null`.
 */
function landInFlight(s: SimState, c: StepContext, horizon = s.world): { at: number; step: number } | null {
  const landed = s.pending
    .filter((item) => item.landsAt != null && item.landsAt <= horizon + 1e-9)
    .sort((a, b) => a.landsAt! - b.landsAt!);
  if (landed.length === 0) return null;
  s.pending = s.pending.filter((item) => !landed.includes(item));
  const now = s.world;
  for (const item of landed) {
    // Delivery reads the clock only to stamp what it puts on the target.
    s.world = item.landsAt!;
    const first = c.status.length;
    deliver(s, c, item.member, item.skill, item.exclude, item.repeat ?? true);
    s.world = now;
    for (let index = first; index < c.status.length; index += 1) c.status[index]!.at = item.landsAt!;
    recoverOnLanding(s, c, item, first);
    c.verdicts.set(`${c.step.index}:landsHere:${item.member.key}`, {
      code: 'landsHere',
      operator: item.member.key,
      skill: item.skill.name,
      step: item.step,
    });
  }
  const last = landed[landed.length - 1]!;
  return { at: last.landsAt!, step: last.step };
}

// ------------------------------------------------------------- resources

/**
 * A Battle Skill pays SP, waiting for it if short. Returned SP («SP Return»)
 * comes back at once and gives no ultimate energy: energy counts only what
 * was really spent.
 */
function payBattleSkill(s: SimState, c: StepContext): void {
  const { skill, step, level } = c;
  if (!skill || step.kind !== 'BS' || c.transformed?.free) return;
  const cost = statAt(skill, 'SP Cost', level, step.sequence) ?? 0;
  if (s.unlimitedSp) s.sp = SP_CAP;
  const ready = s.sp >= cost;
  c.verdicts.set(`${step.index}:sp`, { code: ready ? 'spEnough' : 'spWaiting' });
  if (!ready) wait(s, c, secondsToSp(s, cost), 'SP regenerating');
  s.sp = Math.max(0, s.sp - cost);
  markSp(s);
  // Only a return the cast always gives: Tangtang's «SP Return per Whirlpool» waits on whirlpools.
  const returned = skill.stats
    .filter((row) => row.sp?.kind === 'return' && row.sp.when === 'always' && row.move == null)
    .reduce((sum, row) => sum + (statAt({ ...skill, stats: [row] }, row.label, level, step.sequence) ?? 0), 0);
  const onCast = (s.modifiers[c.member.key]?.spOnCast ?? [])
    .filter((rule) => rule.skillType === 'Battle Skill')
    .reduce((sum, rule) => sum + rule.sp, 0);
  const spent = Math.max(0, cost - returned - onCast);
  s.sp = s.unlimitedSp ? SP_CAP : Math.min(SP_CAP, s.sp + returned + onCast);
  markSp(s);
  const gained = (spent / 100) * ENERGY_PER_100_SP;
  for (const key of Object.keys(s.energy)) s.energy[key] = Math.min(ENERGY_CAP, s.energy[key]! + gained);
}

/**
 * A cast that enters a stance opens it for the skill's `<Stance> Duration
 * (s)`, and closes the one it replaces: Liino's ultimate swaps Vocalist
 * Stance for Cosmovoice. Recasting the battle skill inside the stance ends it
 * for free in game (End Stance); that is not modelled — the cast is paid and
 * the stance restarts.
 */
function enterStance(s: SimState, c: StepContext): void {
  const { skill, member, level, step } = c;
  const entry = skill ? s.synergy.stances?.[member.key]?.[skill.name] : undefined;
  if (!skill || !entry) return;
  if (entry.replaces) s.stances.delete(`${member.key}:${entry.replaces}`);
  const seconds = statAt(skill, `${entry.enters} Duration (s)`, level);
  if (seconds == null) return;
  s.stances.set(`${member.key}:${entry.enters}`, tEnd(s, seconds));
  c.verdicts.set(`${step.index}:stance`, { code: 'stanceEntered', stance: entry.enters, until: tEnd(s, seconds) });
}

/**
 * An ultimate that turns the battle skill into another move for a while:
 * Camille's Hunter Pursuit for its `State Duration`. The next battle skill in
 * the window is that move, once (measurements, #48).
 */
function gainTransform(s: SimState, c: StepContext): void {
  const { skill, member, level, step } = c;
  const entry = skill ? s.synergy.transforms?.[member.key]?.[skill.name] : undefined;
  if (!skill || !entry || c.secondPhase) return;
  const seconds = statAt(skill, entry.window ?? `${entry.into} State Duration (s)`, level);
  const until = seconds == null ? null : tEnd(s, seconds);
  s.transformed.set(member.key, { entry, until });
  c.verdicts.set(`${step.index}:transform`, { code: 'transformGained', move: entry.into, until });
}

/** The battle skill pressed inside the window is the move, and the window closes. */
function useTransform(s: SimState, c: StepContext): void {
  const held = s.transformed.get(c.member.key);
  if (!held) return;
  if (held.until != null && s.world >= held.until) {
    s.transformed.delete(c.member.key);
    return;
  }
  if (c.step.kind !== 'BS' || KIND_TO_SKILL.BS !== held.entry.skill) return;
  c.transformed = held.entry;
  s.transformed.delete(c.member.key);
  c.verdicts.set(`${c.step.index}:transformed`, { code: 'transformedCast', move: held.entry.into, as: held.entry.as });
}

/**
 * An ultimate that enhances the basic attack (`Skill.enhancedBasic`):
 * Laevatain's Twilight, for its `Duration` from the cast (the client's
 * `buff_<char>_ult_end` is created on its first frame). What the chain
 * applies, the cast itself does not: «BATK sequence 3 also applies Heat
 * Infliction».
 */
function openEnhancedBasic(s: SimState, c: StepContext): void {
  const { skill, member, level, step } = c;
  const entry = step.kind === 'ULT' ? skill?.enhancedBasic : undefined;
  if (!skill || !entry) return;
  for (const { term } of entry.applies) c.exclude.add(term);
  const seconds = statAt(skill, entry.window, level);
  if (seconds == null) return;
  s.enhancedBasic.set(member.key, { entry, skill, until: tEnd(s, seconds) });
  c.verdicts.set(`${step.index}:enhancedBasic`, { code: 'enhancedBasicGained', move: entry.move, until: tEnd(s, seconds) });
}

/**
 * «Casting the battle skill … or the combo skill … does not shorten the
 * duration of the ultimate»: the client pauses the window while they are
 * cast (`buff_<char>_pause_ult`), so it ends that much later.
 */
function pauseEnhancedBasic(s: SimState, c: StepContext, duration: number): void {
  const window = s.enhancedBasic.get(c.member.key);
  if (!window || s.world >= window.until || !window.entry.pausedBy.includes(c.skillType)) return;
  if (c.step.kind === 'ULT') return;
  window.until += duration;
  c.verdicts.set(`${c.step.index}:enhancedPaused`, { code: 'enhancedBasicPaused', move: window.entry.move, until: window.until });
}

/** Sequences of the chain a basic attack step performs: `BA` up to the Final Strike, a chained `FS` the strike. */
function chainSequences(step: RotStep, chained: boolean, last: number): number[] {
  if (step.sequence != null) return [step.sequence];
  const all = Array.from({ length: last }, (_, index) => index + 1);
  if (step.kind === 'BA') return all.slice(0, -1);
  return chained ? [last] : all;
}

/** The enhanced chain's own applications, on the sequences the step performs. */
function applyEnhancedBasic(s: SimState, c: StepContext): void {
  const enhanced = c.enhancedBasic;
  if (!enhanced) return;
  const performed = chainSequences(c.step, c.chained, enhanced.entry.sequences);
  const wanted = new Set(enhanced.entry.applies.filter((item) => performed.includes(item.sequence)).map((item) => item.term));
  if (wanted.size === 0) return;
  // Only those terms: the rest of what the ultimate's text applies is the cast's.
  const skip = new Set(
    Object.entries(s.synergy.applies[c.member.key] ?? {})
      .filter(([term, skills]) => skills.includes(enhanced.skill.name) && !wanted.has(term))
      .map(([term]) => term),
  );
  deliver(s, c, c.member, enhanced.skill, skip);
}

/**
 * The swapped-in battle skill's strikes put the operator's infliction on the
 * target, each of them (the client's `SpellInfliction` on both ticks): two
 * Heat Infliction from Laevatain's battle skill inside Twilight. Delivered
 * as the ultimate's own term, one by one, so the second is a stack on top.
 */
function applyDuringUltimate(s: SimState, c: StepContext): void {
  const swapped = c.duringUltimate;
  if (!swapped) return;
  const ultimate = swapped.ultimateSkill;
  for (const { sequence, term } of swapped.applies) {
    if (c.step.sequence != null && c.step.sequence !== sequence) continue;
    const skip = new Set(
      Object.entries(s.synergy.applies[c.member.key] ?? {})
        .filter(([other, skills]) => skills.includes(ultimate.name) && other !== term)
        .map(([other]) => other),
    );
    deliver(s, c, c.member, ultimate, skip);
  }
}

/** The battle skill applied its term: the operator's next basic attack is a Final Strike. */
function armStrike(s: SimState, c: StepContext): void {
  const entry = s.synergy.strikeAfter?.[c.member.key];
  if (!entry || c.skill?.name !== entry.skill || (c.member.elite ?? Infinity) < entry.elite) return;
  if (c.applied.includes(entry.term)) s.strikeReady.add(c.member.key);
}

/**
 * A skill that repeats the element already on the target (`Synergy.echoes`):
 * Fluorite's combo and ultimate. The elements that are not there, or have
 * fewer than `min` stacks, are not applied; with none, no infliction at all.
 */
function echoInflictions(s: SimState, c: StepContext): void {
  const entry = c.skill ? s.synergy.echoes?.[c.member.key]?.[c.skill.name] : undefined;
  if (!entry) return;
  const echoed = entry.elements.filter((element) => (s.target.inflictions[element as ArtsElement] ?? 0) >= entry.min);
  for (const element of entry.elements) if (!echoed.includes(element)) c.exclude.add(`${element} Infliction`);
  if (echoed.length === 0) c.exclude.add('Arts Infliction');
  c.verdicts.set(`${c.step.index}:echo`, { code: 'echoed', elements: echoed, min: entry.min });
}

/**
 * A battle skill that sticks a charge on the target (`Synergy.detonates`):
 * Fluorite's Improvised Explosive, until its fuse runs out. «Only 1
 * Improvised Explosive can be present»: a new one replaces it.
 */
function plantFuse(s: SimState, c: StepContext): void {
  const { skill, member, step } = c;
  if (!skill || step.kind !== 'BS') return;
  const entry = Object.values(s.synergy.detonates?.[member.key] ?? {}).find((item) => item.skill === skill.name);
  if (!entry) return;
  s.fuses.set(member.key, { skill: skill.name, until: entry.fuse == null ? Infinity : s.world + entry.fuse, step: step.index });
}

/** The ultimate cast while the charge is still stuck sets it off: its hit lands at this step. */
function detonate(s: SimState, c: StepContext): void {
  const { skill, member, step } = c;
  const entry = skill && step.kind === 'ULT' ? s.synergy.detonates?.[member.key]?.[skill.name] : undefined;
  const fuse = s.fuses.get(member.key);
  if (!entry || !fuse) return;
  s.fuses.delete(member.key);
  if (s.world >= fuse.until) return;
  c.detonated = { skill: fuse.skill, step: fuse.step, boost: entry.boost };
  c.verdicts.set(`${step.index}:detonates`, { code: 'detonated', name: entry.name, step: fuse.step });
}

/** The skill whose rows a step plays, at its level: the host of a transformed move, or the step's own. */
function rowsSkill(c: StepContext): { skill: Skill | undefined; move: string | null; level: number } {
  if (c.enhancedBasic) {
    return { skill: c.enhancedBasic.skill, move: c.enhancedBasic.entry.move, level: c.member.skills.ultimate ?? 1 };
  }
  if (c.duringUltimate) return { skill: c.skill, move: c.duringUltimate.move, level: c.level };
  if (!c.transformed) return { skill: c.skill, move: null, level: c.level };
  return {
    skill: findSkill(c.member.operator, c.transformed.as),
    move: c.transformed.into,
    level: c.member.skills[SKILL_FIELD[c.transformed.as]] ?? 1,
  };
}

/**
 * A skill that leaves something on the field (`Synergy.stocks`): Tangtang's
 * combo, a Whirlpool for its `Duration`. Past the cap the oldest goes
 * (measurements, #49).
 */
function gainStock(s: SimState, c: StepContext): void {
  const { skill, member, level, step } = c;
  const entry = s.synergy.stocks?.[member.key];
  if (!skill || !entry || skill.name !== entry.gainedBy) return;
  const seconds = statAt(skill, `${entry.name} Duration (s)`, level);
  const held = (s.stocks.get(member.key) ?? []).filter((until) => until > s.world);
  held.push(seconds == null ? Infinity : tEnd(s, seconds));
  while (held.length > entry.max) held.shift();
  s.stocks.set(member.key, held);
  c.verdicts.set(`${step.index}:stock`, { code: 'stockGained', term: entry.name, count: held.length });
}

/**
 * The skill that spends the stock takes all of it: one more of what it makes
 * for each, and the rows «per <stock>» — Tangtang's SP Return per Whirlpool,
 * and her P1's 5 SP (a `consumes:Whirlpool` return, per Whirlpool). With
 * only one made, the «multiple» terms are not applied.
 */
function spendStock(s: SimState, c: StepContext): void {
  const { skill, member, level, step } = c;
  const entry = s.synergy.stocks?.[member.key];
  if (!skill || !entry || skill.name !== entry.spentBy || c.transformed) return;
  const spent = (s.stocks.get(member.key) ?? []).filter((until) => until > s.world).length;
  s.stocks.delete(member.key);
  const made = entry.base + spent;
  c.stock = { name: entry.name, spent, made };
  if (made < 2) for (const term of entry.onMany) c.exclude.add(term);
  let sp = 0;
  for (const row of skill.stats) {
    if (row.sp?.when === 'perStock') sp += (statAt({ ...skill, stats: [row] }, row.label, level) ?? 0) * spent;
  }
  for (const rule of s.modifiers[member.key]?.spOnConsume ?? []) {
    if (rule.term === entry.name && (!rule.skillType || rule.skillType === c.skillType)) sp += rule.sp * spent;
  }
  if (sp > 0) {
    s.sp = Math.min(SP_CAP, s.sp + sp);
    markSp(s);
  }
  c.verdicts.set(`${step.index}:stockSpent`, { code: 'stockSpent', term: entry.name, spent, makes: entry.makes, made, sp });
}

/**
 * The skill that spends the operator's own stacks (`Synergy.ownStacks`):
 * Laevatain's battle skill, cast with 4 Melting Flame, takes them all for its
 * extra attack, its Ultimate Energy and the Combustion it forces. Short of
 * them, the cast has none of that. The check is the cast's first frame
 * (the client's `CheckBuffStackNumAdvanced` on frame 0).
 */
function spendOwnStacks(s: SimState, c: StepContext): void {
  const { skill, member, level, step } = c;
  const entry = s.synergy.ownStacks?.[member.key];
  if (!skill || !entry || skill.name !== entry.spentBy.skill || c.transformed || c.secondPhase) return;
  const have = s.ownStacks.get(member.key) ?? 0;
  if (have < entry.spentBy.at) {
    for (const term of entry.spentBy.applies) c.exclude.add(term);
    c.verdicts.set(`${step.index}:ownStacks`, { code: 'ownStacksShort', term: entry.name, have, need: entry.spentBy.at });
    return;
  }
  s.ownStacks.set(member.key, 0);
  c.spentOwn = true;
  c.status.push({ term: entry.name, kind: 'buffSpent', consumed: have, by: member.key });
  // The swapped-in cast has no `extra_usp` in the client: no energy inside the ultimate.
  const energy = entry.spentBy.energy && !c.duringUltimate ? (statAt(skill, entry.spentBy.energy, level) ?? 0) : 0;
  if (energy > 0) s.energy[member.key] = Math.min(ENERGY_CAP, (s.energy[member.key] ?? 0) + energy);
  c.verdicts.set(`${step.index}:ownStacks`, { code: 'ownStacksSpent', term: entry.name, spent: have, energy });
}

/**
 * Stacks the operator's own casts add: Laevatain's battle skill and combo,
 * one each, and her Final Strike — the client's `attack5` creates the same
 * buff (`OwnStackEntry.finalStrike`); the enhanced chain's does not. The
 * spending cast adds none: its Magma Fragment lands while she is at the cap,
 * and the stacks go with the extra attack.
 */
function gainOwnStacks(s: SimState, c: StepContext): void {
  const { skill, member, step } = c;
  const entry = s.synergy.ownStacks?.[member.key];
  if (!skill || !entry || c.spentOwn || c.transformed) return;
  let gained = 0;
  if (step.kind === 'BS' || step.kind === 'CS') {
    gained = entry.gains.filter((gain) => gain.skill === skill.name).reduce((sum, gain) => sum + gain.count, 0);
  } else if (step.kind === 'FS' && !c.enhancedBasic) {
    gained = entry.finalStrike ?? 0;
  }
  if (gained > 0) addOwnStacks(s, c, member.key, entry, gained);
}

function addOwnStacks(s: SimState, c: StepContext, key: string, entry: OwnStackEntry, gained: number): void {
  const before = s.ownStacks.get(key) ?? 0;
  const now = Math.min(entry.max, before + gained);
  s.ownStacks.set(key, now);
  if (now > before) c.ownStacks.push({ operator: key, term: entry.name, from: before, to: now });
  c.verdicts.set(`${c.step.index}:ownStacks:${key}`, { code: 'ownStacksGained', operator: key, term: entry.name, count: now });
}

/**
 * «After the controlled operator's Final Strike or Finisher hits the enemy,
 * Laevatain absorbs Heat Infliction … Every stack … gives Laevatain 1 stack
 * of Melting Flame.» Every Final Strike and finisher on the track is the
 * controlled operator's. She takes the whole infliction while short of the
 * cap (the client checks her stacks first). Absorbing is not consuming (the
 * glossary's `Absorb`): no «consumed» trigger fires.
 */
function absorbIntoStacks(s: SimState, c: StepContext): void {
  if (c.step.kind !== 'FS' && c.step.kind !== 'FIN') return;
  // A finisher off a staggered target is a plain hit: no finisher, nothing absorbed.
  if (c.step.kind === 'FIN' && s.strikes.get('FIN') !== c.step.index) return;
  for (const member of s.team.values()) {
    const entry = s.synergy.ownStacks?.[member.key];
    const absorbs = entry?.absorbs;
    if (!entry || !absorbs || (member.elite ?? Infinity) < absorbs.elite) continue;
    if ((s.ownStacks.get(member.key) ?? 0) >= entry.max) continue;
    const element = inflictionElement(absorbs.term);
    const stacks = element ? (s.target.inflictions[element] ?? 0) : 0;
    if (!element || stacks <= 0) continue;
    s.target.inflictions[element] = 0;
    delete s.inflictionUntil[element];
    c.verdicts.set(`${c.step.index}:absorbs:${member.key}`, {
      code: 'ownStacksAbsorbed',
      operator: member.key,
      term: absorbs.term,
      absorbed: stacks,
      talent: absorbs.talent,
    });
    addOwnStacks(s, c, member.key, entry, stacks * absorbs.count);
  }
}

/** A «multiple» term carries how many were made: its value is the row at that count. */
function stockLevels(s: SimState, c: StepContext): void {
  const entry = s.synergy.stocks?.[c.member.key];
  if (!entry || !c.stock) return;
  for (const debuff of s.target.debuffs) {
    if (entry.onMany.includes(debuff.term) && debuff.source === c.member.key && debuff.appliedAt === s.world) {
      debuff.level = c.stock.made;
    }
  }
}

/** A cast that generates points (`Synergy.charges`): Pogranichnik's ultimate, 5 Steel Oath for 30 s. */
function gainCharges(s: SimState, c: StepContext): void {
  const { skill, member, level, step } = c;
  const entry = skill ? s.synergy.charges?.[member.key]?.[skill.name] : undefined;
  if (!skill || !entry || c.secondPhase) return;
  const seconds = statAt(skill, `${entry.name} Duration`, level);
  const until = seconds == null ? null : tEnd(s, seconds);
  s.charges.set(member.key, { skill, level, entry, left: entry.points, until, step: step.index });
  c.verdicts.set(`${step.index}:charges`, { code: 'chargesGained', term: entry.name, points: entry.points, until });
}

/**
 * Points spent by this step: one per step that applies a Physical Status
 * (anyone's) or is the owner's combo — not one per hit (measurements, #47).
 * A Physical Status that became Vulnerable on a clean target is not one: on a
 * fresh boss Chen's first Lift spent no Steel Oath (#47, as Swordmancer, #60).
 * Each spent point lands the `each` rows as the owner's, the last one only
 * the `last` rows: four Harass, then Decisive Assault (#47). Their SP is the
 * owner's recovered SP.
 */
function spendCharges(s: SimState, c: StepContext): void {
  for (const [owner, charge] of [...s.charges]) {
    if (charge.until != null && s.world >= charge.until) {
      s.charges.delete(owner);
      continue;
    }
    // The cast that generated the points does not spend one.
    if (charge.step === c.step.index) continue;
    const physical =
      charge.entry.on.includes('Physical Status') &&
      c.applied.some(
        (term) => PHYSICAL_STATUS.has(term) && !c.status.some((event) => event.term === term && event.appliedVulnerableInstead),
      );
    const combo = charge.entry.combo && c.member.key === owner && c.step.kind === 'CS';
    if (!physical && !combo) continue;
    charge.left -= 1;
    const last = charge.left <= 0;
    const index = levelIndex(charge.level);
    let sp = 0;
    for (const row of charge.skill.stats) {
      if (row.sp?.kind !== 'recovery') continue;
      if (row.sp.when === (last ? 'chargeLast' : 'charge')) sp += row.values[index] ?? 0;
    }
    if (sp > 0) {
      s.sp = Math.min(SP_CAP, s.sp + sp);
      markSp(s);
    }
    c.charges.push({ owner, skill: charge.skill.name, name: charge.entry.name, last, sp });
    // The point's own Stagger: Decisive Assault's 15 lands with the last point,
    // not at the ultimate (Harass has none, measurements, #62).
    const prefix = last ? charge.entry.last : charge.entry.each;
    const stagger = prefix ? statAt(charge.skill, `${prefix} Stagger`, charge.level) : null;
    if (stagger) addStagger(s, c, owner, stagger);
    c.verdicts.set(`${c.step.index}:charge:${owner}`, {
      code: 'chargeSpent',
      operator: owner,
      term: charge.entry.name,
      left: Math.max(0, charge.left),
      sp,
    });
    if (last) s.charges.delete(owner);
  }
}

/** `Frame.spRecoveredBy`: the actor's own recovery and what spent points recovered for their owners. */
function recoveredBy(c: StepContext, own: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (own > 0) out[c.member.key] = own;
  for (const charge of c.charges) if (charge.sp > 0) out[charge.owner] = (out[charge.owner] ?? 0) + charge.sp;
  for (const [owner, sp] of Object.entries(c.landedSp)) out[owner] = (out[owner] ?? 0) + sp;
  return out;
}

/** An ultimate spends the caster's energy; its second phase costs nothing. */
function payUltimate(s: SimState, c: StepContext): void {
  const { skill, step, member } = c;
  if (!skill || step.kind !== 'ULT' || c.secondPhase) return;
  const cost = ultimateCost(member, s.modifiers[member.key]);
  const have = s.energy[member.key] ?? 0;
  const ready = have >= cost;
  c.verdicts.set(`${step.index}:energy`, { code: ready ? 'energyCharged' : 'energyNotCharged' });
  if (!ready) c.problems.push({ code: 'ultimateNotCharged', needs: cost, has: have });
  s.energy[member.key] = 0;
}

/**
 * A Battle Skill or Ultimate spends every Link on the team at once (wiki,
 * `Link`). A second phase is the same ultimate and spends nothing.
 */
function spendLink(s: SimState, c: StepContext): void {
  const { step, member } = c;
  // A transformed move treated as a combo skill is not a battle skill: it leaves Link alone.
  if (!c.skill || (step.kind !== 'BS' && step.kind !== 'ULT') || c.secondPhase || c.transformed || s.links.length === 0) return;
  const count = Math.min(s.links.length, LINK_BONUS[step.kind].length);
  const bonus = LINK_BONUS[step.kind][count - 1]!;
  s.links = [];
  c.link = { count, bonus };
  markConsumed(s, c, 'Link', count);
  c.status.push({ term: 'Link', kind: 'buffSpent', consumed: count, by: member.key });
  c.verdicts.set(`${step.index}:link`, { code: 'linkSpent', count, bonus });
}

/**
 * A dodge or a pause: time passes, and nothing else happens — except the SP
 * of a perfect dodge, which also holds natural regen for a moment.
 */
function filler(s: SimState, step: RotStep, member: TeamMember): Frame {
  const c = newStep(s, step, member);
  expire(s, c);
  takeControl(s, c);
  s.comboBlock = [];
  const duration =
    step.kind === 'WAIT'
      ? Math.max(0, step.seconds ?? 0)
      : durationOf(s.timings, step.kind, member.key, 'Dodge', s.scale);
  const dodge = s.spTable.perfectDodge;
  if (step.kind === 'DODGE' && dodge) {
    s.regenPausedUntil = s.world + dodge.regenPause;
    s.sp = Math.min(SP_CAP, s.sp + dodge.sp);
    markSp(s);
    c.verdicts.set(`${step.index}:dodge`, { code: 'perfectDodge', sp: dodge.sp, pause: dodge.regenPause });
  } else if (step.kind === 'WAIT') {
    c.verdicts.set(`${step.index}:wait`, { code: 'pause', seconds: duration });
  }
  const frame: Frame = {
    step: c.step,
    world: s.world,
    real: s.real,
    duration,
    sp: s.sp,
    energy: { ...s.energy },
    cooldowns: Object.fromEntries(s.readyAt),
    target: cloneTarget(s.target),
    staggeredAtStart: s.target.staggered,
    status: [],
    problems: c.problems,
    verdicts: c.verdicts,
    combos: openCombos(s, duration),
    applied: [],
    spRecovered: 0,
    spRecoveredBy: {},
    charges: [],
    transformed: null,
    enhancedBasic: null,
    duringUltimate: null,
    ownStacks: [],
    stock: null,
    detonated: null,
    stacksForHit: 0,
    moves: null,
    enhanced: false,
    link: null,
    links: s.links.map((link) => ({ ...link })),
    chained: false,
    controlled: s.controlled,
    holds: { input: duration, own: duration, chain: duration },
    clientTimed: false,
  };
  noteControlled(s, step);
  hold(s, member.key, frame.holds, step.kind);
  s.pressedAt.set(step.index, s.world);
  return frame;
}

/**
 * A skill that cuts the combo cooldown of whoever stands in a slot (Si's
 * ultimate → slot 01). In the client this is `SetSkillCdAtOnce` with
 * functionType 0: the remaining cooldown drops at once, future cooldowns stay.
 * A talent with two levels: the higher one the elite stage unlocks applies.
 */
function cutComboCooldown(s: SimState, c: StepContext): void {
  const { skill, member, step } = c;
  const cut = c.slotRules
    .filter(
      (rule): rule is Extract<TeamPositionRule, { kind: 'comboCooldownCut' }> =>
        rule.kind === 'comboCooldownCut' && rule.skill === skill?.name && rule.elite <= (member.elite ?? Infinity),
    )
    .sort((a, b) => b.seconds - a.seconds)[0];
  if (!cut) return;
  const holderKey = s.order[cut.slot - 1];
  const holder = holderKey ? s.team.get(holderKey) : undefined;
  const key = `${step.index}:cooldownCut`;
  if (!holder) {
    c.verdicts.set(key, { code: 'cooldownCutEmptySlot', slot: cut.slot });
    return;
  }
  const readyKey = `${holder.key}:Combo Skill`;
  const was = s.readyAt.get(readyKey) ?? 0;
  if (was > s.world) {
    const now = Math.max(s.world, was - cut.seconds);
    s.readyAt.set(readyKey, now);
    c.verdicts.set(key, { code: 'cooldownCut', operator: holder.key, slot: cut.slot, seconds: cut.seconds, was, now });
  } else {
    c.verdicts.set(key, { code: 'cooldownCutWasted', operator: holder.key, slot: cut.slot, seconds: cut.seconds });
  }
}

// ------------------------------------------------------------- combo

/** The target as a trigger sees it: live stack counts and consumption events. */
function liveFor(s: SimState, key: string): LiveTarget {
  const { target } = s;
  return {
    count: (term) => {
      if (term === 'Vulnerable') return target.vulnerable;
      if (term === 'Arts Infliction') return Math.max(...INFLICTION_ELEMENTS.map((element) => target.inflictions[element]));
      const element = inflictionElement(term);
      return element ? target.inflictions[element] : null;
    },
    active: (term) =>
      s.debuffTerms.has(term) ? target.debuffs.some((debuff) => debuff.term === term) : null,
    consumedAt: s.consumedAt,
    latest: s.latest,
    lastCast: s.lastCast.get(key) ?? 0,
    strikes: s.strikes,
    inStance: (stance) => (s.stances.get(`${key}:${stance}`) ?? -1) > s.world,
  };
}

/**
 * A combo waits out its cooldown, then checks its trigger, then the order of
 * simultaneous combos. `CS1 > CS2` is two sequences of ONE cast: only the
 * first pays cooldown and gains energy — read as two casts, Rossi's rotation
 * would look impossible.
 */
function castCombo(s: SimState, c: StepContext): void {
  const { skill, step, member } = c;
  if (!skill || step.kind !== 'CS') return;
  if (step.sequence != null && step.sequence > 1) return;

  const readyKey = `${member.key}:Combo Skill`;
  const availableAt = s.readyAt.get(readyKey) ?? 0;
  const ready = s.world >= availableAt;
  // Written before the cooldown ends: the press waits, and says how long —
  // a wait nobody sees reads as a combo cast on time.
  c.verdicts.set(
    `${step.index}:cooldown`,
    ready ? { code: 'cooldownReady' } : { code: 'comboOnCooldown', seconds: availableAt - s.world },
  );
  // «Tangtang: CS > CS» with a 12 s cooldown means "cast, then again when it
  // is back", and the wait is how the engine derives the cycle length.
  if (!ready) wait(s, c, availableAt - s.world, 'combo cooldown');

  // What opens a combo is the whole point of the notation: combos are not
  // cast at will, someone earlier in the chain has to provide the trigger.
  // Checked at the moment of the cast, i.e. after the wait.
  let check = checkTrigger(s.synergy, member.key, s.provided, liveFor(s, member.key));
  // A battle skill's hit still on its way may be what opens it: the player
  // presses the combo when it lights up (#63).
  for (const item of [...s.pending].sort((a, b) => (a.landsAt ?? Infinity) - (b.landsAt ?? Infinity))) {
    if (!check.trigger || isOpen(check) || item.landsAt == null || item.landsAt <= s.world) continue;
    const before = s.world;
    wait(s, c, item.landsAt - s.world, 'battle skill hit in flight');
    c.verdicts.set(`${step.index}:waitsForHit:${item.member.key}`, { code: 'waitsForHit', operator: item.member.key, seconds: s.world - before });
    check = checkTrigger(s.synergy, member.key, s.provided, liveFor(s, member.key));
  }
  // Opened by a Final Strike still swinging: the combo lights up on its hit.
  if (check.trigger?.on && isOpen(check)) {
    const strike = s.strikeHits.get(check.satisfiedBy[0]?.step ?? -1);
    if (strike && strike.at > s.world + 1e-9) {
      const seconds = strike.at - s.world;
      wait(s, c, seconds, 'Final Strike hit');
      c.verdicts.set(`${step.index}:waitsForStrike`, { code: 'waitsForStrike', operator: strike.actor, seconds });
    }
  }
  // Opened by another operator's combo: it lights up on that combo's hit —
  // the Endministrator's came after Lifeng's thrust, not his press (#66).
  if (check.trigger?.on && isOpen(check)) {
    const hit = s.comboHits.get(check.satisfiedBy[0]?.step ?? -1);
    if (hit && hit.at > s.world + 1e-9) {
      const seconds = hit.at - s.world;
      wait(s, c, seconds, 'combo hit');
      c.verdicts.set(`${step.index}:waitsForComboHit`, { code: 'waitsForComboHit', operator: hit.actor, seconds });
    }
  }
  const trigger = check.trigger;
  if (trigger) {
    if (!isOpen(check)) {
      if (check.present.length > 0) c.problems.push({ code: 'triggerBlocked', terms: check.present });
      if (check.outOfStance) c.problems.push({ code: 'triggerOutOfStance', operator: member.key, stance: check.outOfStance });
      for (const group of check.missing) {
        c.problems.push({
          code: 'triggerMissing',
          terms: group.map((term) => {
            const min = trigger.min?.[term];
            return min ? { term, min } : { term };
          }),
          consumed: Boolean(trigger.consumed),
        });
      }
      c.verdicts.set(`${step.index}:trigger`, { code: 'triggerNotOpen' });
    } else {
      c.verdicts.set(`${step.index}:trigger`, { code: 'triggerOpenedBy', by: check.satisfiedBy });
      stillLit(s, c, trigger, check, availableAt);
    }
  } else {
    // Read from the wiki but not something the track can see: say so, so an
    // unchecked combo does not pass for a checked one.
    const parsed = s.synergy.comboTriggers[member.key];
    if (parsed) {
      c.verdicts.set(`${step.index}:trigger`, parsed.own ? { code: 'triggerUnread', own: parsed.own } : { code: 'triggerUnread' });
    }
  }

  // Simultaneous trigger: two combos written back to back and opened by the
  // SAME event are cast by the game in Combo Skill Priority order, by team
  // position without one. A combo opened by the previous combo's hit is a
  // chain, not simultaneity, and priority does not touch it.
  if (trigger && isOpen(check) && ready) {
    // What opened the combo just now. For a «stacks consumed» trigger that
    // is the moment of consumption, not of application — otherwise Camille's
    // combo, opened by Rossi's combo consuming stacks, looks simultaneous
    // with it. An unknown moment is NaN, and order is not checked at all.
    const momentOf = (term: string): number | undefined =>
      trigger.consumed && isStackTerm(term) ? s.consumedAt.get(term) : s.latest.get(term);
    // An action trigger's event counts too: without it Ardelia's «Final
    // Strike on a clean enemy» has no groups and no moment at all.
    const strike = trigger.on ? [check.satisfiedBy[0]?.step ?? NaN] : [];
    const openedAt = Math.max(
      ...strike,
      ...trigger.groups.map((group) => {
        const moments = group.flatMap((term) => {
          const at = momentOf(term);
          return at === undefined ? [] : [at];
        });
        return moments.length > 0 ? Math.max(...moments) : NaN;
      }),
    );
    const mine = s.priority.indexOf(member.key);
    for (const earlier of s.comboBlock) {
      if (earlier.openedAt !== openedAt) continue;
      if (mine < s.priority.indexOf(earlier.key)) {
        c.problems.push({ code: 'comboOutOfOrder', operator: member.key, other: earlier.key, otherStep: earlier.index });
        c.verdicts.set(`${step.index}:priority`, { code: 'priorityOutOfOrder' });
      } else if (!c.verdicts.has(`${step.index}:priority`)) {
        c.verdicts.set(`${step.index}:priority`, { code: 'priorityInOrder', after: earlier.index });
      }
    }
    s.comboBlock.push({ key: member.key, index: step.index, openedAt });
  } else {
    s.comboBlock = [];
  }

  if (trigger?.consumed && isOpen(check)) {
    c.triggerStacks = Math.max(0, ...check.satisfiedBy.map((hit) => s.consumedCount.get(hit.term) ?? 0));
  }
  if (skill.moves?.by === 'stacks') {
    c.moves = Math.min(skill.moves.max, c.triggerStacks);
    c.enhanced = skill.moves.enhanced != null && c.triggerStacks >= skill.moves.enhanced.stacks;
    c.verdicts.set(`${step.index}:moves`, {
      code: 'movesByStacks',
      moves: c.moves,
      stacks: c.triggerStacks,
      enhanced: c.enhanced,
    });
  }
  s.lastCast.set(member.key, step.index);
  s.strikes.set(`CS:${member.key}`, step.index);
  const first = (windowsHits(s, member)?.CS ?? []).find((hit) => !hit.late);
  if (first) {
    s.comboHits.set(step.index, {
      at: warp(s.dilations, s.world, first.at, member.key),
      actor: member.key,
      from: s.world,
      after: first.at,
    });
  }
  const mod = s.modifiers[member.key];
  const cooldown =
    ((statAt(skill, 'Cooldown', c.level) ?? 0) + (mod?.cooldownFlat?.['Combo Skill'] ?? 0)) *
    (1 + (mod?.cooldownPct?.['Combo Skill'] ?? 0));
  s.readyAt.set(readyKey, s.world + Math.max(0, cooldown));
  const gain = statAt(skill, /Ultimate Energy Gain/i, c.level) ?? COMBO_ENERGY;
  s.energy[member.key] = Math.min(ENERGY_CAP, (s.energy[member.key] ?? 0) + gain);
}

/**
 * A combo stays ready `comboReady` seconds after what opened it (#65): one
 * pressed later is not there to press. The moment is the latest of what
 * closed its groups — a Final Strike's hit, a term put on the target, stacks
 * consumed, another combo's hit. An unknown moment is not checked. A
 * trigger that came while the combo was on cooldown lit nothing: the
 * button is grey, and nothing triggers it then (#72, Teo).
 */
function stillLit(s: SimState, c: StepContext, trigger: ComboTrigger, check: TriggerCheck, readyAt: number): void {
  const ready = s.timings.comboReady;
  const moment = triggerMoment(s, trigger, check);
  if (ready == null || moment == null) return;
  if (moment < readyAt - 1e-6) {
    c.problems.push({ code: 'comboTriggerOnCooldown', seconds: readyAt - moment });
    return;
  }
  const late = s.world - moment;
  if (late > ready + 1e-6) {
    c.problems.push({ code: 'comboExpired', seconds: late, ready });
    c.verdicts.set(`${c.step.index}:lit`, { code: 'comboWentDark', seconds: late, ready });
  }
}

/**
 * When a combo's trigger fired: for an action trigger, the action's hit (a
 * Final Strike's, a combo's); otherwise the latest of what closed its groups
 * — a term put on the target, stacks consumed. `null` — not known.
 */
function triggerMoment(s: SimState, trigger: ComboTrigger, check: TriggerCheck): number | null {
  if (check.satisfiedBy.length === 0) return null;
  // An action trigger fires on the action alone — «a Final Strike on an
  // enemy with Physical Susceptibility» — and the terms only have to stand
  // then; Susceptibility applied later does not light it again.
  if (trigger.on) {
    const action = check.satisfiedBy[0]!.step;
    return (s.strikeHits.get(action) ?? s.comboHits.get(action))?.at ?? s.pressedAt.get(action) ?? null;
  }
  const moments = check.satisfiedBy.map((hit) => {
    const strike = s.strikeHits.get(hit.step) ?? s.comboHits.get(hit.step);
    if (strike) return strike.at;
    if (trigger.consumed && isStackTerm(hit.term)) return s.pressedAt.get(s.consumedAt.get(hit.term) ?? -1);
    // The term's latest application, if that is the step that closed the
    // group; otherwise the step itself (a consumption, Arclight's «again
    // when it is consumed»).
    const latest = s.latestAt.get(hit.term);
    return latest && latest.step === hit.step ? latest.at : s.pressedAt.get(hit.step);
  });
  return moments.some((moment) => moment == null) ? null : Math.max(...(moments as number[]));
}

// ------------------------------------------------------------- stagger

/** Final Strike and Finisher: damage, and a source of SP. */
function finalStrikeAndFinisher(s: SimState, c: StepContext): void {
  const { step, skill, member, verdicts } = c;
  if (skill && step.kind === 'FS') {
    s.strikes.set('FS', step.index);
    const hit = strikeHitIn(s, c);
    if (hit != null) {
      s.strikeHits.set(step.index, { at: warp(s.dilations, s.world, hit, member.key), actor: member.key, from: s.world, after: hit });
    }
    const restored = c.enhancedBasic?.entry.finalStrikeSp ?? finalStrikeSp(s.spTable, member.key, member.operator.name);
    s.sp = Math.min(SP_CAP, s.sp + restored);
    markSp(s);
    verdicts.set(`${step.index}:fs`, { code: 'finalStrikeSp', sp: restored });
  }

  if (step.kind !== 'FIN') return;
  // A finisher exists only on a staggered target: the first basic attack on
  // it becomes one.
  const ready = s.target.staggered;
  verdicts.set(`${step.index}:finisher`, { code: ready ? 'finisherReady' : 'finisherNotReady' });
  if (!ready) {
    c.problems.push(
      s.enemy.staggerMeter == null
        ? { code: 'finisherNoMeter' }
        : { code: 'finisherNotStaggered', stagger: s.target.stagger, meter: s.enemy.staggerMeter },
    );
    return;
  }
  s.strikes.set('FIN', step.index);
  s.sp = Math.min(SP_CAP, s.sp + (s.enemy.finisherSp || s.spTable.finisher.default));
  markSp(s);
  // The finisher spends the stagger.
  s.target.staggered = false;
  s.target.stagger = 0;
}

/**
 * Seconds from the Final Strike's press to its hit: the last segment's hit
 * that restores SP (`finalStrikeHit`) — Lifeng's second, not his first
 * (#68c); without it, the segment's first hit. A strike that finishes the BA
 * before it starts where that BA stopped; one on its own walks the whole
 * chain. `null` — no client frames (an enhanced chain).
 */
function strikeHitIn(s: SimState, c: StepContext): number | null {
  if (c.enhancedBasic || c.step.sequence != null) return null;
  const basic = s.spTable.basicAttack?.[c.member.key] ?? s.spTable.basicAttack?.[c.member.operator.name];
  const first = basic?.finalStrikeHit ?? basic?.chainHits?.at(-1)?.[0];
  if (first == null || basic?.sequenceSeconds == null || basic.finalStrikeSeconds == null) return null;
  const start = c.chained ? basic.sequenceSeconds - basic.finalStrikeSeconds : 0;
  return Math.max(0, first - start);
}

/** Terms this cast has taken so far: Link it spent, debuffs and reactions it consumed, its own stacks. */
function spentBy(c: StepContext): Set<string> {
  return new Set(
    c.status
      .filter(
        (event) =>
          ((event.kind === 'debuffConsumed' || event.kind === 'reactionConsumed') && event.consumer === c.member.key) ||
          (event.kind === 'buffSpent' && event.by === c.member.key),
      )
      .map((event) => event.term),
  );
}

/** Stagger builds while the target is not staggered; at the meter it is. */
function buildStagger(s: SimState, c: StepContext): void {
  const { step } = c;
  const { skill, move, level } = rowsSkill(c);
  if (!skill) return;
  // A Final Strike on the track is the controlled operator's by definition.
  const strike = c.enhancedBasic ? c.enhancedBasic.entry.finalStrikeStagger : skill.finalStrikeStagger;
  // What the cast already did that a conditional row asks about: the Link it spent, the stacks it ate.
  const context = { consumed: spentBy(c), moves: c.moves, enhanced: c.enhanced };
  // Points the cast generates land their Stagger where they are spent (`spendCharges`).
  const charge = s.synergy.charges?.[c.member.key]?.[skill.name];
  const skip = charge ? [charge.each, ...(charge.last ? [charge.last] : [])] : [];
  // The first hit's own Stagger lands first: if it fills the meter, the rest
  // of the cast hits a staggered target (Chen's ultimate, measurements, #45).
  const opening = staggerOf(skill, level, step.sequence, move, context, skip, FIRST_STRIKE);
  if (opening > 0 && !s.target.staggered) {
    addStagger(s, c, c.member.key, opening);
    if (s.target.staggered) c.brokenByFirstHit = true;
  }
  const base = staggerOf(skill, level, step.sequence, move, context, [...skip, FIRST_STRIKE]) + (step.kind === 'FS' ? (strike ?? 0) : 0);
  addStagger(s, c, c.member.key, base);
}

/** The row prefix of the Stagger a cast's first hit carries: Chen's ultimate «First Strike Stagger». */
const FIRST_STRIKE = 'First Strike';

/**
 * Stagger dealt by an operator: scaled by their Stagger Efficiency (Swordmancer's
 * +20 % made Chen's Final Strike 19 and her battle skill 12, measurements,
 * #62). Builds while the target is not staggered; at the meter it is.
 */
function addStagger(s: SimState, c: StepContext, by: string, base: number): void {
  if (base <= 0 || s.target.staggered || s.enemy.staggerMeter == null) return;
  const { step } = c;
  const applied = base * (1 + (s.modifiers[by]?.stagger?.efficiency ?? 0));
  const before = s.target.stagger;
  s.target.stagger += applied;
  if (s.target.stagger >= s.enemy.staggerMeter) {
    s.target.staggered = true;
    s.target.staggeredUntil = s.world + s.enemy.staggerRecovery;
    s.strikes.set('STG', step.index);
    c.verdicts.set(`${step.index}:stagger`, { code: 'targetStaggered' });
    return;
  }
  const meter = s.enemy.staggerMeter;
  const node = (s.enemy.staggerNodes ?? []).find((share) => before < share * meter && share * meter <= s.target.stagger);
  if (node !== undefined) {
    s.strikes.set('STG', step.index);
    c.verdicts.set(`${step.index}:stagger`, { code: 'staggerNode', share: node });
  }
}

/**
 * Stagger of the statuses this delivery applied: Lift and Knock Down deal 10 ×
 * (1 + AI / 200), on a full Vulnerable too; a status that became Vulnerable on a
 * clean target deals none. An effect hit that fires on a Physical Status
 * (Swordmancer) adds its own, at most once per its cooldown (measurements, #62).
 */
function statusStagger(s: SimState, c: StepContext, by: string, events: readonly StatusEvent[]): void {
  const mods = s.modifiers[by]?.stagger;
  const real = events.filter((event) => !event.appliedVulnerableInstead);
  for (const event of real) {
    const base = STATUS_STAGGER[event.term];
    if (base) addStagger(s, c, by, base * (1 + (mods?.artsIntensity ?? 0) / 200));
  }
  for (const hit of mods?.hits ?? []) {
    const fires = real.some((event) => event.term === hit.on || (hit.on === 'Physical Status' && PHYSICAL_STATUS.has(event.term)));
    const key = `${by}:${hit.name}`;
    if (!fires || (s.hitReadyAt.get(key) ?? -Infinity) > s.world + 1e-9) continue;
    s.hitReadyAt.set(key, s.world + hit.cooldown);
    addStagger(s, c, by, hit.stagger);
  }
}

// ------------------------------------------------------------- applications

/**
 * The slot decides WHAT a skill applies: Si's battle skill gives Heat
 * Infliction instead of Cryo when a Heat operator stands in slot 01. Synergy
 * sees both inflictions in the text, and without the rule the engine would
 * apply both at once.
 */
function swapBySlot(s: SimState, c: StepContext): void {
  for (const rule of c.slotRules) {
    if (rule.kind !== 'swapTerm' || rule.skill !== c.skill?.name) continue;
    const holderKey = s.order[rule.slot - 1];
    const holder = holderKey ? s.team.get(holderKey) : undefined;
    const holds = holder?.operator.element === rule.element;
    c.exclude.add(holds ? rule.term : rule.alt);
    c.verdicts.set(
      `${c.step.index}:slot:${rule.term}`,
      holds
        ? { code: 'slotSwap', term: rule.term, alt: rule.alt, slot: rule.slot, operator: holder!.key, element: rule.element }
        : { code: 'slotKeep', term: rule.term, slot: rule.slot, element: rule.element },
    );
  }
}

/**
 * A term appeared on the target this step: for triggers and simultaneity.
 * `without` — implications that do not hold this time (`deliverTerms`).
 */
function note(s: SimState, c: StepContext, term: string, without: ReadonlySet<string> = new Set()): void {
  provide(s.provided, s.synergy, term, c.step.index, new Set(without));
  const fresh: Provided = new Map();
  provide(fresh, s.synergy, term, c.step.index, new Set(without));
  for (const [name, at] of fresh) {
    s.latest.set(name, at);
    s.latestAt.set(name, { at: s.noteAt ?? s.world, step: c.step.index });
  }
}

function markConsumed(s: SimState, c: StepContext, term: string, count = 1): void {
  s.consumedAt.set(term, c.step.index);
  s.consumedCount.set(term, count);
  if (inflictionElement(term)) {
    s.consumedCount.set('Arts Infliction', count);
    s.consumedAt.set('Arts Infliction', c.step.index);
  }
  if (classify(term).kind === 'consumesInfliction') s.consumedAt.set('Arts Reaction', c.step.index);
}

function addDebuff(
  s: SimState,
  term: string,
  source: string,
  duration: number | null,
  level?: number,
  skill?: string,
  receiver?: string,
): void {
  s.target.debuffs = s.target.debuffs.filter((debuff) => debuff.term !== term || debuff.receiver !== receiver);
  s.debuffTerms.add(term);
  s.target.debuffs.push({
    term,
    source,
    appliedAt: s.world,
    expiresAt: duration != null ? tEnd(s, duration) : null,
    ...(level != null ? { level } : {}),
    ...(skill != null ? { skill } : {}),
    ...(receiver != null ? { receiver } : {}),
  });
}

/** How much of a term the target has: stacks, or 1 for a standing debuff. */
function targetHolds(target: TargetState, term: string): number {
  if (term === 'Vulnerable') return target.vulnerable;
  const element = inflictionElement(term);
  if (element) return target.inflictions[element];
  return target.debuffs.some((debuff) => debuff.term === term) ? 1 : 0;
}

/** The categories a grant term belongs to: they go when the last of their members does. */
const GRANT_UMBRELLAS: Record<SkillGrant['stat'], string[]> = {
  susceptibility: ['Susceptible', 'Susceptibility'],
  amp: ['Amp', 'Arts Amp'],
};

/**
 * «If the target has Corrosion, … apply Physical Susceptibility» (Ardelia),
 * «if the enemy … has no Vulnerability stacks» (Lifeng): a grant whose
 * condition the target did not meet as the cast landed is not applied —
 * not for damage, not for a trigger.
 */
function grantsMet(s: SimState, c: StepContext, by: string, skill: Skill, terms: string[]): string[] {
  const grants = skill.grants ?? [];
  const before = c.before ?? s.target;
  const mods = s.modifiers[by]?.grants ?? [];
  const unmet = grants.filter((grant) => {
    const requires = grant.requires;
    if (!requires || !terms.includes(grant.term)) return false;
    // Lifeng's P1: «also triggers … to enemies with no more than 2 Vulnerability stacks».
    const atMost = Math.max(0, ...grantModifiers(mods, skill, grant.term).map((mod) => mod.atMost ?? 0));
    return (requires.has != null && targetHolds(before, requires.has) === 0) || (requires.lacks != null && targetHolds(before, requires.lacks) > atMost);
  });
  for (const grant of unmet) {
    c.verdicts.set(`${c.step.index}:withheld:${grant.term}`, { code: 'grantWithheld', term: grant.term, ...grant.requires });
  }
  // The Auxiliary Crystal's Amp waits for a Final Strike: not on the cast.
  const waiting = grants.filter((grant) => grant.on && terms.includes(grant.term));
  if (unmet.length === 0 && waiting.length === 0) return terms;
  const dropped = new Set([...unmet, ...waiting].map((grant) => grant.term));
  for (const stat of new Set([...unmet, ...waiting].map((grant) => grant.stat))) {
    const left = grants.some((grant) => grant.stat === stat && !dropped.has(grant.term) && terms.includes(grant.term));
    if (left) continue;
    for (const umbrella of GRANT_UMBRELLAS[stat]) {
      if (!grants.some((grant) => grant.term === umbrella)) dropped.add(umbrella);
    }
  }
  return terms.filter((term) => !dropped.has(term));
}

/** A grant's duration row at the applier's level (`SkillGrant.duration`), with what potentials add. */
function grantSeconds(s: SimState, by: string, skill: Skill, term: string, level: number): number | null {
  const row = skill.grants?.find((grant) => grant.term === term)?.duration;
  const seconds = row ? statAt(skill, row, level) : null;
  if (seconds == null) return null;
  const mods = grantModifiers(s.modifiers[by]?.grants ?? [], skill, term);
  return seconds + mods.reduce((sum, mod) => sum + (mod.durationDelta ?? 0), 0);
}

/** A cast whose grant waits for a strike arms it: Xaihi's Auxiliary Crystal. */
function armGrants(s: SimState, c: StepContext, by: string, skill: Skill, level: number, terms: string[]): void {
  for (const grant of skill.grants ?? []) {
    if (!grant.on || !terms.includes(grant.term)) continue;
    const window = statAt(skill, grant.on.window, level);
    const until = window != null ? tEnd(s, window) : Infinity;
    s.armed = s.armed.filter((item) => !(item.owner === by && item.grant.term === grant.term));
    s.armed.push({ owner: by, skill, grant, level, until, left: grant.on.times });
    c.verdicts.set(`${c.step.index}:armed:${grant.term}`, {
      code: 'grantArmed',
      term: grant.term,
      times: grant.on.times,
      until: Number.isFinite(until) ? until : null,
    });
  }
}

/**
 * «After the controlled operator performs a Final Strike … grant the said
 * operator a temporary Arts Amp»: each Final Strike within the window spends
 * one use and puts the Amp on the striker. «When the controlled operator is
 * already at Max HP»: the dummy never hits back, so always (measurements, #50).
 */
function strikeGrants(s: SimState, c: StepContext): void {
  s.armed = s.armed.filter((item) => item.until > s.world + 1e-9 && item.left > 0);
  if (c.step.kind !== 'FS' || c.step.actor !== s.controlled) return;
  for (const item of s.armed) {
    item.left -= 1;
    const seconds = grantSeconds(s, item.owner, item.skill, item.grant.term, item.level);
    addDebuff(s, item.grant.term, item.owner, seconds, undefined, item.skill.name, c.member.key);
    note(s, c, item.grant.term);
    c.applied.push(item.grant.term);
    c.appliedBy.push({ term: item.grant.term, by: item.owner });
    c.status.push({ term: item.grant.term, kind: 'other', by: item.owner });
    c.verdicts.set(`${c.step.index}:strike:${item.grant.term}`, {
      code: 'grantOnStrike',
      term: item.grant.term,
      operator: item.owner,
      left: item.left,
    });
  }
  s.armed = s.armed.filter((item) => item.left > 0);
}

/**
 * Vulnerable or a Physical Status on a frozen target consumes Solidification
 * and causes Shatter (wiki, Solidification). This is how Estella's Lift opens
 * Alesh's «Arts Reaction consumed» combo.
 */
function shatter(s: SimState, c: StepContext): void {
  const frozen = s.target.debuffs.find((debuff) => debuff.term === 'Solidification');
  if (!frozen) return;
  s.target.debuffs = s.target.debuffs.filter((debuff) => debuff.term !== 'Solidification');
  markConsumed(s, c, 'Solidification');
  note(s, c, 'Shatter');
  // Shatter's damage belongs to whoever broke it (measurements, #25); its level is the reaction's.
  c.status.push({ term: 'Shatter', kind: 'other', consumed: frozen.level ?? 1 });
  c.verdicts.set(`${c.step.index}:shatter`, { code: 'shatter' });
}

/**
 * 1. A skill's own consumption — «consume all Cryo Infliction stacks» —
 * comes before its applications: Last Rite's combo eats what already stands.
 * A two-move combo eats on its second move: Rossi's second sequence does.
 */
function consumeOwn(s: SimState, c: StepContext): void {
  const { skill, step, member, status } = c;
  const { target } = s;
  if (!skill || (step.kind === 'CS' && step.sequence === 1)) return;
  // A transformed move eats by its own paragraph (Bolt Rush), not the host's.
  const name = c.transformed?.into ?? skill.name;
  const eats = Object.entries(s.synergy.consumes?.[member.key] ?? {}).filter(([, skills]) => skills.includes(name));
  for (const [term] of eats) {
    const eaten: Array<{ term: string; count?: number }> = [];
    const first = status.length;
    if (term === 'Vulnerable') {
      if (target.vulnerable > 0) {
        status.push({ term, kind: 'consumesVulnerable', consumed: target.vulnerable });
        eaten.push({ term: 'Vulnerable', count: target.vulnerable });
        markConsumed(s, c, 'Vulnerable', target.vulnerable);
        target.vulnerable = 0;
      }
    } else if (term === 'Arts Infliction' || inflictionElement(term)) {
      const only = inflictionElement(term);
      for (const element of INFLICTION_ELEMENTS) {
        if (only && element !== only) continue;
        const consumed = target.inflictions[element];
        if (consumed === 0) continue;
        target.inflictions[element] = 0;
        markConsumed(s, c, `${element} Infliction`, consumed);
        status.push({ term: `${element} Infliction`, kind: 'consumesInfliction', consumed, element });
        eaten.push({ term: `${element} Infliction`, count: consumed });
      }
    } else {
      // A reaction on the target: Solidification, Electrification and so on.
      const names = term === 'Arts Reaction' ? [...reactionsOnTarget(target)] : [term];
      for (const name of names) {
        const debuff = target.debuffs.find((item) => item.term === name);
        if (!debuff) continue;
        // A barrage consumes it with its closing strike, seconds later: it may be gone by then.
        const strikeAt = step.kind === 'ULT' ? skill.barrage?.strikeAt : undefined;
        if (strikeAt != null && debuff.expiresAt != null && debuff.expiresAt <= s.world + strikeAt) {
          c.verdicts.set(`${step.index}:goneBeforeStrike:${name}`, { code: 'goneBeforeStrike', term: name, until: debuff.expiresAt });
          continue;
        }
        target.debuffs = target.debuffs.filter((item) => item.term !== name);
        markConsumed(s, c, name);
        eaten.push({ term: name });
        // Not a reaction: a debuff ended early (the ultimate shattering the
        // crystals). It counts for whoever put it there, and the step knows
        // it consumed it.
        if (classify(name).kind !== 'consumesInfliction') {
          status.push({ term: name, kind: 'debuffConsumed', consumed: 1, by: debuff.source, consumer: member.key });
        } else {
          // A reaction taken by the cast: «consumes Solidification» triggers and rows read it.
          status.push({ term: name, kind: 'reactionConsumed', consumed: 1, by: member.key, consumer: member.key });
        }
      }
    }
    if (eaten.length > 0) c.verdicts.set(`${step.index}:consumes:${term}`, { code: 'consumed', items: eaten });
    for (let index = first; index < status.length; index += 1) status[index]!.by ??= member.key;
  }
}

/** 2. The skill's own applications — or holding them until the next Final Strike. */
function applyOwn(s: SimState, c: StepContext): void {
  const { skill, member, step } = c;
  if (!skill) return;
  // A transformed move applies what its own paragraph says (`Bolt Rush: …`),
  // read under the move's name; Hunter Pursuit's says nothing.
  if (c.transformed) {
    if (!c.secondPhase) deliver(s, c, member, { ...skill, name: c.transformed.into }, c.exclude);
    return;
  }
  if (s.synergy.deferred?.[member.key]?.[skill.name] === 'FS') {
    const window = statAt(skill, /^Duration \(s\)$/, c.level);
    s.pending.push({
      member,
      skill,
      exclude: c.exclude,
      step: step.index,
      expiresAt: window != null ? tEnd(s, window) : Infinity,
    });
    c.verdicts.set(`${step.index}:deferred`, { code: 'deferred', window });
  } else if (!c.secondPhase) {
    if (ultimateHits(s, c)) return;
    const lands = landsAfterStep(s, c);
    if (lands != null) {
      s.pending.push({
        member,
        skill,
        exclude: c.exclude,
        step: step.index,
        expiresAt: Infinity,
        landsAt: warp(s.dilations, s.world, lands, member.key),
        landsFrom: s.world,
        landsAfter: lands,
      });
      c.verdicts.set(`${step.index}:landsLater`, { code: 'landsLater', seconds: lands });
    } else {
      // Delivered with the cast, as nothing comes between: what it opens
      // still lights up at its hit (#65 counts from there).
      s.noteAt = ownHitAt(s, c);
      deliver(s, c, member, skill, c.exclude);
      s.noteAt = null;
    }
  }
}

/**
 * An ultimate whose status hits are known delivers at each of them: the
 * first hit what the cast applies, every next one a repeat of it
 * (`synergy.repeats`). Lifeng's slams: Knock Down at 2.13 s and again at
 * 4.17 s of his own clock, a combo's slowdown in between pushing the second
 * back (measurements, #73). A hit still coming at the next press lands
 * inside the step it falls in, as a background battle skill's (#63); one
 * that nothing comes before lands with the cast. `false` — no such hits.
 */
function ultimateHits(s: SimState, c: StepContext): boolean {
  const { skill, member, step } = c;
  if (step.kind !== 'ULT' || !skill || c.transformed) return false;
  const hits = (windowsHits(s, member)?.ULT ?? []).filter((hit) => hit.status);
  if (hits.length === 0) return false;
  const repeated = s.synergy.repeats?.[member.key]?.[skill.name] ?? {};
  const own = Object.entries(s.synergy.applies[member.key] ?? {})
    .filter(([, skills]) => skills.includes(skill.name))
    .map(([term]) => term);
  hits.forEach((hit, index) => {
    let exclude = c.exclude;
    if (index > 0) {
      const again = new Set(Object.entries(repeated).filter(([, times]) => times > index).map(([term]) => term));
      if (again.size === 0) return;
      exclude = new Set([...c.exclude, ...own.filter((term) => !again.has(term))]);
    }
    const landsAt = warp(s.dilations, s.world, hit.at, member.key);
    if (s.next && pressGate(s, s.next) < s.world + hit.at - 1e-9) {
      s.pending.push({
        member,
        skill,
        exclude,
        step: step.index,
        expiresAt: Infinity,
        landsAt,
        landsFrom: s.world,
        landsAfter: hit.at,
        repeat: false,
      });
      c.verdicts.set(`${step.index}:landsLater:${index}`, { code: 'landsLater', seconds: hit.at });
    } else {
      s.noteAt = landsAt;
      deliver(s, c, member, skill, exclude, false);
      s.noteAt = null;
    }
  });
  return true;
}

/**
 * World time a battle skill's or a combo's statuses land: the battle skill's
 * status hit (`lands`), the combo's first hit. `null` — at the press.
 */
function ownHitAt(s: SimState, c: StepContext): number | null {
  if (c.transformed) return null;
  if (c.step.kind === 'BS') {
    const lands = windowsOf(s, c.member)?.BS?.lands;
    return lands == null ? null : warp(s.dilations, s.world, lands, c.member.key);
  }
  if (c.step.kind === 'CS') return s.comboHits.get(c.step.index)?.at ?? null;
  return null;
}

/** 3. A Final Strike brings what was held back for it. */
function landDeferred(s: SimState, c: StepContext): void {
  const held = s.pending.filter((item) => item.landsAt == null);
  if (c.step.kind !== 'FS' || held.length === 0) return;
  for (const item of held) {
    deliver(s, c, item.member, item.skill, item.exclude);
    c.verdicts.set(`${c.step.index}:delivers:${item.member.key}`, {
      code: 'delivers',
      operator: item.member.key,
      skill: item.skill.name,
    });
  }
  s.pending = s.pending.filter((item) => item.landsAt != null);
}

/** The values of a mark entry at this member's elite (unknown elite — the highest). */
function markValues(s: SimState, entry: MarkEntry, owner: string): { boost: number; perStack: number; perPoint: number } {
  const elite = s.team.get(owner)?.elite ?? 4;
  const pick = <T extends { elite: number }>(rows: T[] | undefined): T | undefined =>
    rows?.filter((row) => row.elite <= elite).sort((a, b) => b.elite - a.elite)[0];
  const blast = pick(entry.byElite);
  return { boost: blast?.boost ?? 1, perStack: blast?.perStack ?? 0, perPoint: pick(entry.aiByElite)?.perPoint ?? 0 };
}

/**
 * A reaction an operator with a mark applied: its DMG Taken may cover every
 * type, and it leaves as many mark stacks as its Status Level (Argent
 * Flow's Electrification → Sunderization, up to 12, 60 s; #59).
 */
function leaveMarks(s: SimState, c: StepContext, by: TeamMember): void {
  const entry = s.synergy.marks?.[by.key];
  if (!entry) return;
  if ((s.team.get(by.key)?.elite ?? 4) < Math.min(...entry.byElite.map((row) => row.elite))) return;
  for (const debuff of s.target.debuffs) {
    if (debuff.marked || debuff.term !== entry.reaction || debuff.source !== by.key || Math.abs(debuff.appliedAt - s.world) > 1e-9) continue;
    debuff.marked = true;
    if (entry.allTypes) debuff.allTypes = true;
    let mark = s.target.marks.find((item) => item.term === entry.name && item.by === by.key && item.expiresAt > s.world + 1e-9);
    if (!mark) {
      mark = { term: entry.name, by: by.key, stacks: 0, expiresAt: 0 };
      s.target.marks = s.target.marks.filter((item) => item.term !== entry.name);
      s.target.marks.push(mark);
    }
    mark.stacks = Math.min(entry.max, mark.stacks + (debuff.level ?? 1));
    mark.expiresAt = tEnd(s, entry.seconds);
    c.verdicts.set(`${c.step.index}:marks:${entry.name}`, { code: 'markStacks', mark: entry.name, stacks: mark.stacks });
  }
}

/** A status that sets off a standing mark: the boost to it and the explosion event. */
function detonateMarks(s: SimState, status: string): { boost: number; event: StatusEvent } | null {
  const index = s.target.marks.findIndex((mark) => {
    const entry = s.synergy.marks?.[mark.by];
    return entry?.name === mark.term && entry.status === status && mark.expiresAt > s.world + 1e-9 && mark.stacks > 0;
  });
  if (index < 0) return null;
  const mark = s.target.marks[index]!;
  const entry = s.synergy.marks![mark.by]!;
  s.target.marks.splice(index, 1);
  const values = markValues(s, entry, mark.by);
  return {
    boost: values.boost,
    event: {
      term: mark.term,
      kind: 'markDetonated',
      by: mark.by,
      consumed: mark.stacks,
      multiplier: mark.stacks * values.perStack,
      aiPerPoint: values.perPoint,
      blastElement: entry.element,
    },
  };
}

/** What skill `bySkill` of operator `by` puts on the target, and the marks it leaves. */
function deliver(s: SimState, c: StepContext, by: TeamMember, bySkill: Skill, skip: Set<string>, repeat = true): void {
  deliverTerms(s, c, by, bySkill, skip);
  leaveMarks(s, c, by);
  addVulnerable(s, c, by, bySkill);
  if (repeat) deliverRepeats(s, c, by, bySkill, skip);
}

/**
 * A term one cast applies more than once, delivered again on its own, so the
 * second lands on top of the first: two Knock Downs, two Vulnerable stacks.
 * Where the hits are known, each rides its own (`ultimateHits`); this is the
 * fallback, everything with the cast.
 */
function deliverRepeats(s: SimState, c: StepContext, by: TeamMember, bySkill: Skill, skip: Set<string>): void {
  const repeated = s.synergy.repeats?.[by.key]?.[bySkill.name];
  if (!repeated) return;
  for (const [term, times] of Object.entries(repeated)) {
    if (skip.has(term)) continue;
    const others = new Set(
      Object.entries(s.synergy.applies[by.key] ?? {})
        .filter(([other, skills]) => skills.includes(bySkill.name) && other !== term)
        .map(([other]) => other),
    );
    for (let time = 1; time < times; time += 1) deliverTerms(s, c, by, bySkill, new Set([...skip, ...others]));
  }
}

/** «After consuming the target's Electric Infliction, … also applies 1 stack of Vulnerability». */
function addVulnerable(s: SimState, c: StepContext, by: TeamMember, bySkill: Skill): void {
  const entry = s.synergy.vulnerableStacks?.[by.key]?.[bySkill.name];
  if (!entry || s.consumedAt.get(entry.after) !== c.step.index) return;
  s.target.vulnerable = Math.min(MAX_STACKS, s.target.vulnerable + entry.count);
  c.verdicts.set(`${c.step.index}:vulnerableAdded`, { code: 'vulnerableAdded', count: entry.count, stacks: s.target.vulnerable });
}

function deliverTerms(s: SimState, c: StepContext, by: TeamMember, bySkill: Skill, skip: Set<string>): void {
  const { target } = s;
  const { status, verdicts, step } = c;
  const bonusOf = (reaction: string): number => s.reactionBonus[by.key]?.[reaction] ?? 0;
  const byLevel = by.skills[SKILL_FIELD[bySkill.type]] ?? 1;
  const terms = applySkill(s.provided, s.synergy, by.key, bySkill, step.index, skip);
  armGrants(s, c, by.key, bySkill, byLevel, terms);
  const applied = grantsMet(s, c, by.key, bySkill, terms);
  // Crush and Breach imply Vulnerable only on a clean target; on stacks they
  // eat them, and the enemy does not «become Vulnerable» — Chen's combo does
  // not light on the Endministrator's Crush.
  const eats = target.vulnerable > 0 ? new Set(['Vulnerable']) : new Set<string>();
  for (const term of applied) note(s, c, term, classify(term).kind === 'consumesVulnerable' ? eats : undefined);
  c.applied.push(...applied);
  for (const term of applied) c.appliedBy.push({ term, by: by.key });
  const physical = applied.some((term) => PHYSICAL_STATUS.has(term));
  if (physical) shatterCrystals(s, c, by.key);
  const first = status.length;
  if (physical) shatter(s, c);

  for (const term of [...applied].sort()) {
    // Link is a buff on the team, not on the target: the next Battle Skill
    // or Ultimate spends it (`spendLink`).
    if (term === 'Link') {
      const seconds = durationForTerm(bySkill.stats, term, bySkill.terms, byLevel);
      s.links.push({ term, source: by.key, appliedAt: s.world, expiresAt: seconds != null ? tEnd(s, seconds) : null });
      status.push({ term, kind: 'other' });
      continue;
    }
    const kind = classify(term);
    switch (kind.kind) {
      case 'umbrella': {
        // A category or the stack itself: does not move a counter, draws no window.
        status.push({ term, kind: kind.kind });
        break;
      }
      case 'buildsVulnerable': {
        // The first Physical Status on a clean target applies Vulnerable
        // INSTEAD of itself and makes no damage instance at all. The
        // measurements warn about it: the first hit on a fresh boss and a
        // hit inside a rotation are different things.
        const wasClean = target.vulnerable === 0;
        target.vulnerable = Math.min(MAX_STACKS, target.vulnerable + 1);
        status.push(wasClean ? { term, kind: kind.kind, appliedVulnerableInstead: true } : { term, kind: kind.kind });
        break;
      }
      case 'consumesVulnerable': {
        // Status Level is the number of stacks CONSUMED, not of those standing.
        const consumed = target.vulnerable;
        target.vulnerable = 0;
        if (consumed > 0) markConsumed(s, c, 'Vulnerable', consumed);
        const blast = consumed > 0 ? detonateMarks(s, term) : null;
        status.push(blast ? { term, kind: kind.kind, consumed, boost: blast.boost } : { term, kind: kind.kind, consumed });
        if (blast) {
          status.push(blast.event);
          verdicts.set(`${step.index}:mark`, { code: 'markDetonated', mark: blast.event.term, stacks: blast.event.consumed ?? 0, boost: blast.boost });
        }
        // Breach leaves a Physical DMG Taken debuff: 12–30 s by level.
        if (term === 'Breach' && consumed > 0) {
          const level = Math.min(consumed, MAX_STACKS);
          addDebuff(s, 'Breach', by.key, BREACH_DEBUFF[level]?.duration ?? null, level);
        }
        if (consumed > 0) verdicts.set(`${step.index}:statusLevel:${term}`, { code: 'statusLevel', level: consumed });
        break;
      }
      case 'infliction': {
        // Wiki, Arts Infliction and Arts Reaction: the same element adds a
        // stack and an Arts Burst; another element reacts. The INCOMING
        // element sets the reaction, the standing stacks consumed set the level.
        const element = kind.element;
        const standing = INFLICTION_ELEMENTS.find((other) => other !== element && target.inflictions[other] > 0);
        if (standing) {
          const consumed = target.inflictions[standing];
          const reaction = REACTION_OF[element];
          target.inflictions[standing] = 0;
          markConsumed(s, c, `${standing} Infliction`, consumed);
          note(s, c, reaction);
          note(s, c, 'Arts Reaction');
          addDebuff(s, reaction, by.key, reactionSeconds(reaction, consumed, bonusOf(reaction)), consumed);
          status.push({ term: reaction, kind: 'consumesInfliction', consumed, element: standing });
          status.push({ term: reaction, kind: 'other' });
          verdicts.set(`${step.index}:statusLevel:${reaction}`, { code: 'statusLevel', level: consumed });
          verdicts.set(`${step.index}:reaction`, { code: 'reaction', element, standing, consumed, reaction });
        } else {
          const had = target.inflictions[element];
          target.inflictions[element] = Math.min(MAX_STACKS, had + 1);
          s.inflictionUntil[element] = tEnd(s, INFLICTION_SECONDS);
          status.push(had > 0 ? { term, kind: kind.kind, element, burst: true } : { term, kind: kind.kind, element });
          if (had > 0) {
            note(s, c, `${element} Burst`);
            note(s, c, 'Arts Burst');
            verdicts.set(`${step.index}:burst`, { code: 'burst', element, stack: had + 1 });
          }
        }
        break;
      }
      case 'consumesInfliction': {
        // A reaction named in the skill text. A forced one («forcibly apply»)
        // eats no stacks and goes at level I, per the wiki — that is how
        // Perlica's combo leaves Cryo under Corrosion alone. A normal one eats
        // the largest stack: which pair of elements it is, the text does not say.
        const forced = s.synergy.forced?.[by.key]?.[term]?.includes(bySkill.name) ?? false;
        note(s, c, 'Arts Reaction');
        // A potential that edits what this skill applies (Laevatain's P3: ×1.5 duration, ×1.5 per tick).
        const edit = s.modifiers[by.key]?.reactionEdits?.find(
          (item) => item.reaction === term && (item.skillType == null || item.skillType === bySkill.type),
        );
        const seconds = durationForTerm(bySkill.stats, term, bySkill.terms, byLevel) ?? reactionSeconds(term, 1, bonusOf(term));
        // Bolt Rush: level I, +1 per stack this cast consumed — one Electric
        // stack gave level II (measurements, #59).
        const leveled = s.synergy.forcedLevels?.[by.key]?.[bySkill.name];
        const eaten =
          leveled?.reaction === term && s.consumedAt.get(leveled.per) === step.index ? (s.consumedCount.get(leveled.per) ?? 0) : 0;
        const forcedLevel = Math.min(MAX_STACKS, 1 + eaten);
        addDebuff(s, term, by.key, seconds != null ? seconds * (edit?.duration ?? 1) : null, forcedLevel);
        if (eaten > 0) verdicts.set(`${step.index}:statusLevel:${term}`, { code: 'statusLevel', level: forcedLevel });
        if (edit && edit.dot !== 1) s.target.debuffs[s.target.debuffs.length - 1]!.dotScale = edit.dot;
        status.push(forced ? { term, kind: 'other', forced: true } : { term, kind: 'other' });
        if (forced) {
          verdicts.set(`${step.index}:reaction:${term}`, { code: 'reactionForced', term });
          break;
        }
        let best: ArtsElement | null = null;
        for (const element of INFLICTION_ELEMENTS) {
          if (target.inflictions[element] > (best ? target.inflictions[best] : 0)) best = element;
        }
        const consumed = best ? target.inflictions[best] : 0;
        if (best && consumed > 0) {
          target.inflictions[best] = 0;
          markConsumed(s, c, `${best} Infliction`, consumed);
          const reaction = target.debuffs.find((debuff) => debuff.term === term);
          if (reaction) {
            reaction.level = consumed;
            const seconds = reactionSeconds(term, consumed, bonusOf(term));
            if (seconds != null && reaction.expiresAt != null) reaction.expiresAt = tEnd(s, seconds);
          }
        }
        status.push(best ? { term, kind: kind.kind, consumed, element: best } : { term, kind: kind.kind, consumed: 0 });
        if (consumed > 0) verdicts.set(`${step.index}:statusLevel:${term}`, { code: 'statusLevel', level: consumed });
        break;
      }
      default: {
        // A plain debuff: lasts as long as the skill's stats say.
        const seconds = grantSeconds(s, by.key, bySkill, term, byLevel) ?? durationForTerm(bySkill.stats, term, bySkill.terms, byLevel);
        addDebuff(s, term, by.key, seconds, undefined, bySkill.name);
        status.push({ term, kind: kind.kind });
      }
    }
  }
  for (let index = first; index < status.length; index += 1) status[index]!.by ??= by.key;
  statusStagger(s, c, by.key, status.slice(first));
}

/**
 * Originium Crystals break when a Physical Status or Vulnerable is applied to
 * the sealed target (the Endministrator's combo text; basic attacks and Final
 * Strike do not break them — measurements, #10). The shards are the
 * Endministrator's damage (#2), so the event is hers; `consumer` is who broke them.
 */
function shatterCrystals(s: SimState, c: StepContext, consumer: string): void {
  const crystals = s.target.debuffs.find((debuff) => debuff.term === CRYSTAL);
  if (!crystals) return;
  s.target.debuffs = s.target.debuffs.filter((debuff) => debuff !== crystals);
  markConsumed(s, c, CRYSTAL);
  c.status.push({ term: CRYSTAL, kind: 'debuffConsumed', consumed: 1, by: crystals.source, consumer });
  c.verdicts.set(`${c.step.index}:crystals`, { code: 'crystalsShattered', owner: crystals.source, by: consumer });
}

/**
 * SP a potential returns when the operator's own skill consumes a term — the
 * Endministrator's P1: 50 SP when her battle skill takes the crystals;
 * Laevatain's P1: 20 SP when her battle skill spends Melting Flame.
 */
function returnSpOnConsume(s: SimState, c: StepContext): void {
  const key = c.member.key;
  for (const rule of s.modifiers[key]?.spOnConsume ?? []) {
    if (rule.skillType && rule.skillType !== c.skillType) continue;
    const took = c.status.some(
      (event) =>
        event.term === rule.term &&
        (event.kind === 'debuffConsumed' || event.kind === 'reactionConsumed'
          ? event.consumer === key
          : event.by === key &&
            (event.consumed ?? 0) > 0 &&
            // Her own stacks spent count: Laevatain's P1 returns SP when the battle skill takes Melting Flame.
            (event.kind.startsWith('consumes') || (event.kind === 'buffSpent' && event.term !== 'Link'))),
    );
    if (!took) continue;
    s.sp = Math.min(SP_CAP, s.sp + rule.sp);
    markSp(s);
    c.verdicts.set(`${c.step.index}:spReturned:${rule.term}`, { code: 'spReturned', sp: rule.sp, term: rule.term });
  }
}

/** Debuffs run out by world time; what remains is reported. */
function expireDebuffs(s: SimState, c: StepContext): void {
  s.target.debuffs = s.target.debuffs.filter((debuff) => debuff.expiresAt == null || debuff.expiresAt > s.world);
  for (const debuff of s.target.debuffs) {
    c.verdicts.set(`${c.step.index}:debuff:${debuff.term}`, { code: 'debuffActive', until: debuff.expiresAt });
  }
}

/**
 * «SP Recovery by Consuming N Vulnerability Stacks» of a hit that landed
 * inside a later step: Pogranichnik's battle skill, its Breach coming 1.42 s
 * after the press while the Endministrator is already swinging. The stacks
 * are eaten here, so the recovery is counted here, for the skill the hit
 * belongs to — `recoverSp` reads only the step's own cast. The SP comes at
 * the hit: a hit still ahead of the clock waits in `spLater` for `advance`.
 */
function recoverOnLanding(s: SimState, c: StepContext, item: Pending, first: number): void {
  const { member, skill } = item;
  const eaten = Math.max(
    0,
    ...c.status
      .slice(first)
      .filter((event) => event.by === member.key)
      .map((event) =>
        event.kind === 'consumesVulnerable' || event.kind === 'consumesInfliction' ? (event.consumed ?? 0) : 0,
      ),
  );
  if (eaten === 0) return;
  const index = levelIndex(member.skills[SKILL_FIELD[skill.type]] ?? 1);
  let recovered = 0;
  for (const row of skill.stats) {
    const role = row.sp;
    if (!role || role.kind !== 'recovery' || row.move != null) continue;
    if (role.when === 'consumed' && role.stacks === Math.min(eaten, MAX_STACKS)) recovered += (row.values[index] ?? 0) * (role.count ?? 1);
  }
  if (recovered <= 0) return;
  if (item.landsAt != null && item.landsAt > s.world + 1e-9) {
    s.spLater.push({ at: item.landsAt, sp: recovered });
  } else {
    s.sp = Math.min(SP_CAP, s.sp + recovered);
    markSp(s);
  }
  c.landedSp[member.key] = (c.landedSp[member.key] ?? 0) + recovered;
  c.verdicts.set(`${c.step.index}:spRecoveredBy:${member.key}`, { code: 'spRecoveredFor', operator: member.key, skill: skill.name, sp: recovered });
}

/**
 * SP the skill recovers («SP Recovery») — not a return and not passive regen.
 * Frontiers, Thermite Cutter and Fervent Morale trigger on it. What each row
 * means was decided by `export.py` (`sp_roles`). «by Consuming N Stacks»
 * looks at what THIS step ate, so it counts after the applications.
 */
function recoverSp(s: SimState, c: StepContext): number {
  const { member, step, status } = c;
  const { skill, move, level } = rowsSkill(c);
  if (!skill) return 0;
  const eatenNow = Math.max(
    0,
    ...status
      .filter((event) => event.by === member.key)
      .map((event) =>
        event.kind === 'consumesVulnerable' || event.kind === 'consumesInfliction' ? (event.consumed ?? 0) : 0,
      ),
  );
  const index = levelIndex(level);
  const enhancedAt = skill.moves?.enhanced?.sequence;
  const sequenceCounts = (role: { sequence?: number; stacks?: number }): boolean => {
    // The enhanced stage replaces the plain one, and only when it happened.
    if (role.stacks != null) return c.enhanced;
    if (c.moves != null) return (role.sequence ?? 0) <= c.moves && !(c.enhanced && role.sequence === enhancedAt);
    // A step without a move number is the whole cast: all its moves.
    return step.sequence == null || step.sequence === role.sequence;
  };
  let recovered = 0;
  for (const row of skill.stats) {
    const role = row.sp;
    if (!role || role.kind !== 'recovery' || (row.move ?? null) !== move) continue;
    // A transformed move recovers by its own rows (`when: transformed`), and only those.
    const counts = move
      ? role.when === 'transformed'
      : role.when === 'always' ||
        (role.when === 'consumed' && role.stacks === Math.min(eatenNow, MAX_STACKS)) ||
        (role.when === 'sequence' && sequenceCounts(role));
    if (counts) recovered += (row.values[index] ?? 0) * (role.count ?? 1);
  }
  if (recovered > 0) {
    s.sp = Math.min(SP_CAP, s.sp + recovered);
    markSp(s);
    c.verdicts.set(`${step.index}:spRecovered`, { code: 'spRecovered', sp: recovered });
  }
  return recovered;
}

/** Combos whose trigger is open after the step, and when each can be pressed. */
function openCombos(
  s: SimState,
  duration: number,
  landed?: { before: Set<string>; at: number; step: number },
): Frame['combos'] {
  const combos: Frame['combos'] = [];
  const window = s.timings.comboReady;
  for (const member of s.team.values()) {
    const { key } = member;
    const check = checkTrigger(s.synergy, key, s.provided, liveFor(s, key));
    if (!check.trigger || !isOpen(check)) continue;
    // Off cooldown, and its operator free (under `steps` nobody is busy past the step).
    const ready = Math.max(s.readyAt.get(`${key}:Combo Skill`) ?? 0, s.ownFreeAt.get(key) ?? 0);
    // It lights up when its trigger fires — a Final Strike's hit, another
    // combo's hit — and goes dark 6 s later (#65): one that cannot be
    // pressed by then is not offered.
    const openedAt = triggerMoment(s, check.trigger, check);
    // A trigger while the button is grey lights nothing (#72).
    if (openedAt != null && openedAt < (s.readyAt.get(`${key}:Combo Skill`) ?? 0) - 1e-6) continue;
    if (openedAt != null && window != null && ready > openedAt + window + 1e-6) continue;
    // Opened by a hit inside the step: ready from that hit.
    if (landed && !landed.before.has(key)) {
      combos.push({ key, at: Math.max(landed.at, ready), by: landed.step, ...(openedAt != null ? { openedAt } : {}) });
    } else if (openedAt != null) {
      combos.push({ key, at: Math.max(openedAt, ready, s.world), openedAt });
    } else {
      combos.push({ key, at: Math.max(s.world + duration, ready) });
    }
  }
  return combos;
}

/** Operators whose combo trigger is open right now. */
function openKeys(s: SimState): Set<string> {
  const keys = new Set<string>();
  for (const other of s.team.values()) {
    const check = checkTrigger(s.synergy, other.key, s.provided, liveFor(s, other.key));
    if (check.trigger && isOpen(check)) keys.add(other.key);
  }
  return keys;
}
