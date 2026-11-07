/**
 * Types of the bundle that `tools/ef/export.py` builds.
 *
 * The contract between Python and TypeScript rests on one number —
 * `SCHEMA`. If it drifts, the app refuses to read the data instead of
 * silently reading fields wrong.
 */

import type { EffectsSection } from './effects.js';
import type { SpTable } from './simulate.js';
import type { Timings } from './timing.js';
import type { Synergy } from './triggers.js';

export const SCHEMA = 39;

/**
 * A number's unit. It exists because in the wiki's source data percentages
 * and flat values look the same: `5.0` is "+5 %" for one effect and
 * "+5 points" for another. The export assigns the unit; the engine only
 * reads it.
 */
export type Unit = 'frac' | 'flat' | 'mult' | 'sec' | 'sp' | 'energy' | 'stagger';

export type Element = 'Physical' | 'Heat' | 'Cryo' | 'Electric' | 'Nature' | 'Aether';

export type SkillType = 'Basic Attack' | 'Battle Skill' | 'Combo Skill' | 'Ultimate';

export type AttributeKey = 'HP' | 'ATK' | 'STR' | 'AGL' | 'INT' | 'WIL';

/** The six points at which the wiki gives a stat value. */
export interface Breakpoint {
  key: string;
  elite: number;
  level: number;
}

export interface StatRow {
  label: string;
  unit: Unit;
  /** Twelve values — one per skill level, 1 to 12. */
  values: number[];
  /**
   * Present only for multi-stage skills: the wiki puts several sequences
   * in one row in a row. Mi Fu's "SP Cost" is 100 for the first stage and
   * 50 each for the second and third.
   */
  sequences?: number[][];
  /**
   * The row belongs to a move another skill turns into, not to this skill's
   * own cast: Camille's `Hunter Pursuit …` rows sit in his combo skill and
   * land on the battle skill his ultimate transforms (`Synergy.transforms`).
   */
  move?: string;
  /**
   * The skill type whose DMG bonuses the hit takes, when it is not the type
   * of the skill the row sits in: Laevatain's enhanced basic attacks and
   * Yvonne's barrage are ultimate rows the client counts as basic attacks
   * (`skillSpecification`, `frames.py`). The row's level is still its own
   * skill's.
   */
  dealtAs?: SkillType;
  /**
   * A Stagger row tied to its hit (`export.py`, `stagger_roles`): `sequence`
   * — the stage its «SEQ n» names; `conditional` — only when the hit's
   * `when` held (Lifeng's `consumes:Link`, Pogranichnik's `stacks:4`, which
   * replaces the plain stage); a conditional row without `when` is never
   * counted, as its hit is not.
   */
  stagger?: { sequence?: number; conditional?: boolean; when?: string };
  /** Not on the wiki's stat table: `export.py` read it from the skill text (Mi Fu's «returns 50 SP»). */
  fromText?: boolean;
  /** The value at this many things made (`Synergy.stocks`): Tangtang's «Arts Susceptibility (3 Waterspouts)». */
  made?: number;
  /**
   * The row is a hit (decided in `export.py`, `hit_roles`). No field — not
   * damage. `role`: `hit` — a hit; `perStack` — a bonus per consumed stack,
   * multiplied by Status Level; `conditional` — only under a condition, not
   * counted in the total. `sequence` — the stage number (`CS2`); `part` —
   * for basic attacks: chain, plunge or finisher. `delayed` — not a hit of
   * the cast itself: it lands later, on the event `when` names
   * (Endministrator's crystal shards, when somebody consumes the crystals).
   */
  hit?: {
    role: 'hit' | 'perStack' | 'conditional' | 'delayed';
    sequence: number | null;
    part: 'chain' | 'dive' | 'finisher' | null;
    /**
     * How many times the row hits (`export.py`, `hit_counts`, from the
     * skill text): no field — one hit; `null` — the count depends on time or
     * stacks and is unknown ("per Beat").
     */
    count?: number | null;
    /**
     * When each of its hits lands, seconds from the press — for a basic
     * attack row, from the start of the chain (`export.py`, `hit_times`, from
     * the client's frames). Missing — not known.
     */
    at?: number[];
    /** Hits once per thing the cast made (`Synergy.stocks`): «DMG Multiplier (1 Waterspout)». */
    per?: string;
    /**
     * The condition, where the skill text states one (`export.py`,
     * `skill_conditions`): `consumes:Link` — the step spent Link;
     * `consumes:Originium Crystal` — it shattered the crystals;
     * `stacks:4` — the cast consumed that many stacks, and the row replaces
     * the plain row of the same sequence; `consumed:<term>` — for `delayed`.
     * A conditional row without it is never counted.
     */
    when?: string;
  };
  /**
   * An SP row (decided in `export.py`, `sp_roles`). `recovery` triggers
   * "on SP recovery" effects, `return` does not. `when`: `always`;
   * `consumed` — if the step consumed exactly `stacks` stacks; `sequence` —
   * on stage `sequence`; `conditional` — the condition is not visible from
   * the label, not counted. `sequence` with `stacks` is an enhanced stage:
   * it replaces that stage's plain row when the cast consumed `stacks`.
   */
  sp?: {
    kind: 'recovery' | 'return';
    when: 'always' | 'consumed' | 'sequence' | 'conditional' | 'charge' | 'chargeLast' | 'transformed' | 'perStock';
    /** Times an `always` row recovers per cast: «per SEQ» with «2 thrust sequences» (Akekuri). */
    count?: number;
    stacks?: number;
    sequence?: number;
  };
}

export interface Skill {
  slot: number;
  type: SkillType;
  name: string;
  /** Stance, if the operator has several (Arcane: INT and WILL). */
  variant: string | null;
  text: string;
  terms: string[];
  icon: string | null;
  stats: StatRow[];
  /**
   * A two-phase ultimate (decided in `export.py`, `ultimate_phases`): the
   * first cast sets something up, and the next cast within `window` seconds
   * is `to` (Arcane's "Gloompurge Arcana"). Phase rows are marked
   * `sequence` 1 and 2.
   */
  switch?: { to: string; window: number | null };
  /**
   * One press, and the stacks decide how many sequences it performs
   * (`export.py`, `skill_conditions`): Pogranichnik's combo slashes as many
   * times as Vulnerable stacks were consumed, up to `max`, and at
   * `enhanced.stacks` the `enhanced.sequence` slash is the enhanced one.
   */
  moves?: { by: 'stacks'; max: number; enhanced?: { stacks: number; sequence: number } };
  /**
   * "As the controlled operator, Final Strike also deals 16 Stagger"
   * (`export.py`, `final_strike_stagger`): the basic attack's only stagger.
   * Basic Attack only.
   */
  finalStrikeStagger?: number;
  /** Susceptibility and Amp the skill puts up itself, with the rows that hold the value (`export.py`, `skill_grants`). */
  grants?: SkillGrant[];
  /** Crit and ATK its own rows grant (`export.py`, `skill_boosts`). */
  boosts?: SkillBoost[];
  /**
   * `last` — the wiki's rows and the client's hits disagree in number, so
   * every row was put on the last hit (`export.py`, `hit_times`).
   */
  hitTimes?: 'last';
  /** An ultimate that is one long cast of enhanced basic attacks (`export.py`, `ultimate_barrage`). */
  barrage?: SkillBarrage;
  /** An ultimate that enhances the basic attack for a window (`export.py`, `enhanced_basic`). */
  enhancedBasic?: SkillEnhancedBasic;
  /**
   * A battle skill the ultimate's window swaps for another (`export.py`,
   * `during_ultimate_rows`): Laevatain's, while Twilight is up, plays its
   * `move` rows and puts `applies` on the target from those sequences.
   */
  duringUltimate?: { move: string; ultimate: string; applies: Array<{ sequence: number; term: string }> };
}

/**
 * Laevatain's ultimate: for `window`, her `BA` and `FS` play the rows of
 * `move` in this skill — a closed chain of `sequences` hits, with the timings
 * and Final Strike numbers of the client's enhanced chain.
 */
export interface SkillEnhancedBasic {
  move: string;
  /** The row with the window's length, from the cast. */
  window: string;
  /** Her own skills that pause the window while they are cast. */
  pausedBy: SkillType[];
  /** What a sequence of the chain applies: «BATK sequence 3 also applies Heat Infliction». */
  applies: Array<{ sequence: number; term: string }>;
  sequences: number;
  sequenceSeconds?: number;
  finalStrikeSeconds?: number;
  finalStrikeSp?: number;
  finalStrikeStagger?: number;
}

/**
 * Yvonne's ultimate: shots for its whole window, written as one `ULT` step.
 * The shot count and the stacks each shot carries come from the client's
 * frames; the values are the skill's rows.
 */
export interface SkillBarrage {
  /** The shot row; its `hit.count` is `shots`. */
  row: string;
  shots: number;
  /** `[stacks the shot is fired with, how many shots]`. */
  ramp: Array<[number, number]>;
  /** Stacks at the end: what the closing strike and the extra attack carry. */
  finalStacks: number;
  /** The step's length: cast, window, closing strike. */
  seconds: number;
  /** Seconds from the cast to the closing strike: what it consumes must last until then. */
  strikeAt: number;
  /** Rows: Crit Rate per stack, Crit DMG at max stacks, the cap. */
  stack?: { rate: string; atMax?: string; max: string };
}

/**
 * A buff a skill's own row grants: Rossi's combo «buffs Rossi's Critical
 * Rate and Critical DMG Dealt», Liino's stance «grants the entire team an
 * ATK Boost».
 */
export interface SkillBoost {
  stat: 'crit_rate' | 'crit_dmg' | 'atk_pct';
  /** The row with the value, read at the skill level. */
  row: string;
  /** `cast` — a buff from the cast on; `own` — only this skill's hits, always (Rossi's ultimate). */
  when: 'cast' | 'own';
  target?: 'self' | 'team';
  /** The row with its duration. */
  duration?: string;
  /** Only this sequence of the cast grants it: «COMBO SEQUENCE 2 … buffs». */
  sequence?: number;
  /** Boosts in one slot replace each other: Liino's two stances. */
  slot?: string;
}

/**
 * «Apply Physical Susceptibility», «grants Cryo Amp and Heat Amp to the
 * entire team»: the term, and how its value is read at the applier's skill
 * level.
 */
export interface SkillGrant {
  /** As the simulation puts it on the target: «Heat Susceptibility», «Cryo Amp». */
  term: string;
  stat: 'susceptibility' | 'amp';
  /** An element or `Arts`. */
  element: string;
  /**
   * Susceptibility sits on the enemy, Amp on every squad member; `controlled`
   * — on whoever performs the strike in `on` (Xaihi's Auxiliary Crystal).
   */
  target: 'enemy' | 'team' | 'controlled';
  /**
   * Not on the cast: «After the controlled operator performs a Final Strike
   * … This effect can trigger 2 times» — `times` strikes within the `window`
   * row's seconds from the cast.
   */
  on?: { strike: 'Final Strike'; times: number; window: string };
  /**
   * Summed. A plain row is the value; `made` — only when the cast made that
   * many (Tangtang's Waterspouts); `per` an attribute — value × the
   * applier's attribute, up to the `max` row, or reaching the row's value at
   * the `at` row's attribute (Arcane's WILL array); `per: Vulnerable` —
   * value × Vulnerable stacks on the target (Gilberta).
   */
  rows: Array<{ row: string; made?: number; per?: AttributeKey | 'Vulnerable'; max?: string; at?: string }>;
  /** The row with its duration; absent — the text names none. */
  duration?: string;
  /** «If the target has Corrosion»: not applied without it. */
  requires?: { has?: string; lacks?: string };
  /** Applied, but not counted: `chance` — left to a roll; `single` — reaches one operator on a condition. */
  uncounted?: 'chance' | 'single';
}

export interface TalentLevel {
  condition: string;
  text: string;
  terms: string[];
  postfix?: string;
}

export interface Talent {
  name: string;
  icon: string | null;
  levels: TalentLevel[];
}

export interface Potential {
  rank: number;
  title?: string | null;
  text: string;
  terms: string[];
}

export interface Operator {
  key: string;
  id: string;
  name: string;
  rarity: number;
  class: string;
  element: Element;
  weaponType: string;
  faction: string | null;
  gender: string | null;
  mainAttribute: string | null;
  subAttribute: string | null;
  tags: string[];
  headhunting: string | null;
  upcoming: boolean;
  critRate: number;
  attackSpeed: number;
  attackRange: string | number | null;
  attributes: Partial<Record<AttributeKey, Record<string, number>>>;
  breakpoints: Breakpoint[];
  skills: Skill[];
  talents: Talent[];
  potentials: Potential[];
  icon: string | null;
  elementIcon: string | null;
  classIcon: string | null;
  revid: number | null;
  page: string;
}

export interface WeaponComponent {
  key: string;
  tag: string | null;
  textTemplate: string;
  terms: string[];
  /** One unit per placeholder `{0}`, `{1}`, … in the text template. */
  units: Unit[];
  /** Converted to fractions where the template says "%". */
  valuesByRank: number[][];
  /** As in the game — for display and for checking against the stat screen. */
  rawValuesByRank: number[][];
}

export interface Weapon {
  key: string;
  id: string;
  name: string;
  rarity: number;
  type: string;
  baseAttack: Record<string, number>;
  breakpoints: Breakpoint[];
  skillName: string | null;
  components: WeaponComponent[];
  potential: { text: string; terms: string[] } | null;
  icon: string | null;
  revid: number | null;
  page: string;
}

export interface GearStat {
  slot: 'primary' | 'secondary' | 'tertiary';
  stat: string;
  unit: Unit;
  /** One value for ordinary gear, four tiers for artifact gear. */
  values: number[];
}

export interface GearPiece {
  key: string;
  name: string;
  type: 'Armor' | 'Gloves' | 'Kit';
  rarity: number;
  level: number;
  set: string | null;
  defense: number;
  artifice: boolean;
  region: string | null;
  stats: GearStat[];
  icon: string | null;
  page: string;
}

export interface GearSet {
  key: string;
  name: string;
  level: number;
  text: string;
  terms: string[];
  effectKnown: boolean;
  /**
   * Where the bonus text was taken from. The wiki lies: the set page and the
   * item pages disagree, and the items are usually right. Cargo is not an
   * independent source — it is filled from the same infobox.
   */
  effectSource: string | null;
  setPageText: string | null;
  conflict: boolean;
}

export interface Enemy {
  key: string;
  id: string;
  name: string;
  class: string;
  type: string;
  hp: number[];
  atk: number[];
  def: number[];
  /** Multiplier: 0.8 means 20 % resistance. Recovered from the letters in the UI. */
  resistances: Partial<Record<Element, number>>;
  resistanceConfidence: 'confirmed' | 'inferred' | 'unknown';
  /**
   * Finisher Multiplier for this specific enemy.
   *
   * Comes from the wiki's `SD` field, which the parser used to label
   * "stagger decay". It is not: the values are exactly {1, 1.25, 1.5, 1.75}
   * from the damage formula, and 83 of 87 enemies match the documented tier
   * table. The four that differ are individual enemies, which is precisely
   * what the wiki allows: "tied to the specific enemy. Currently the values
   * are the same for enemies of the same tier."
   */
  finisherMultiplier: number | null;
  /**
   * SP a Finisher on this enemy refunds — the wiki's `SPG` field, labelled
   * "Finisher SP Gain" in Template:Enemy data. Common 25, Advanced 35,
   * Alpha 50, Boss 100: a boss finisher hands back a whole skill bar.
   */
  finisherSp: number | null;
  /**
   * `nodes` — Stagger Nodes as shares of the meter, from the client
   * (`poiseKnotPctList`): reaching one makes the enemy stumble, and Akekuri's
   * combo opens on it.
   */
  stagger: { hp: number; recovery: number; nodes: number[] };
  weight: number;
  attackRange: number | null;
  revid: number | null;
  page: string;
}

export interface GlossaryTerm {
  term: string;
  name: string;
  title: string | null;
  description: string;
  aliases: string[];
  source_module: string;
}

export interface Mechanic {
  key: string;
  name: string;
  overview: string | null;
  /** The "Calculations" section — a direct specification of the multiplier groups. */
  calculations: string | null;
  sections: Record<string, string>;
  interactions: Record<string, unknown[]>;
  icon: string | null;
  revid: number | null;
}

export interface Bundle {
  schema: number;
  game: 'endfield';
  generatedAt: string;
  source: {
    wiki: string;
    license: string;
    note: string;
    maxRevid: number | null;
    pages: number;
  };
  breakpoints: Breakpoint[];
  operators: Record<string, Operator>;
  weapons: Record<string, Weapon>;
  gear: { pieces: Record<string, GearPiece>; sets: Record<string, GearSet> };
  enemies: Record<string, Enemy>;
  glossary: Record<string, GlossaryTerm>;
  mechanics: Record<string, Mechanic>;
  /**
   * One account's roster. Not part of `bundle.json`: it comes from
   * `roster.json` next to it, when there is one (`attachRoster`). A public
   * build has none.
   */
  roster?: Roster;
  /**
   * The hand-written placement of talents and potentials into the
   * formula's groups. Built from `data/endfield/effects/*.yaml`; without it
   * the damage table is understated, and the app must say so.
   */
  effects: EffectsSection;
  timings: Timings;
  /** SP the wiki does not quantify (`data/endfield/sp.yaml` + measurements). Null without the file. */
  sp?: SpTable | null;
  synergy: Synergy;
  /** The rotations/*.rot files as is: the engine parses them. */
  rotations: Record<string, { name: string; text: string }>;
  /** Operator aliases from roster/aliases.yaml. */
  aliases: Record<string, string[]>;
  counts: Record<string, number>;
}

export class SchemaError extends Error {}

/**
 * Checks that this is a bundle of the expected version.
 *
 * A deliberately coarse check: the aim is not to validate every field but
 * to make incompatible data fail at once with a clear message, rather than
 * turn into `undefined` somewhere in the middle of a damage calculation.
 */
export function assertBundle(value: unknown): asserts value is Bundle {
  if (typeof value !== 'object' || value === null) {
    throw new SchemaError('the bundle is not an object');
  }
  const bundle = value as Partial<Bundle>;
  if (bundle.schema !== SCHEMA) {
    throw new SchemaError(
      `bundle schema ${String(bundle.schema)}, expected ${SCHEMA}. ` +
        'Rebuild it: python3 tools/ef/export.py',
    );
  }
  for (const key of ['operators', 'weapons', 'gear', 'enemies'] as const) {
    if (typeof bundle[key] !== 'object' || bundle[key] === null) {
      throw new SchemaError(`the bundle has no «${key}» section`);
    }
  }
}

/**
 * Attaches `roster.json` (written next to the bundle by `export.py`) to a
 * loaded bundle. A missing or foreign-schema file leaves the bundle without
 * a roster rather than failing: the app works without one.
 */
export function attachRoster(bundle: Bundle, payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const file = payload as { schema?: unknown; roster?: unknown };
  if (file.schema !== SCHEMA || typeof file.roster !== 'object' || file.roster === null) return false;
  bundle.roster = file.roster as Roster;
  return true;
}

// ----------------------------------------------------------------- roster

/**
 * Where a value came from.
 *
 * The distinction is mandatory: `profile` is a fact that came from the game
 * through the Enka showcase; `manual` was entered by hand; `default` was
 * filled in from `defaults` and is a pure assumption. A defaulted skill
 * level of one must not look in the UI the same as a measured twelve.
 */
export type Provenance = 'profile' | 'manual' | 'default';

export interface RosterWeapon {
  name: string | null;
  level: number | null;
  rank: number | null;
  breakthrough: number | null;
  /** The essence sets the weapon skill levels — that column out of nine. */
  essence: {
    template_id: number | null;
    domain_id: number | null;
    total_cost: number | null;
    terms: Array<{ term: number | null; cost: number | null }>;
  } | null;
  /**
   * Each component's column, computed by `export.py` from the essence
   * (measurements, #6). Keyed by component name; `null` — no essence.
   */
  columns: Record<string, WeaponColumn> | null;
}

export interface WeaponColumn {
  /** 1-based; `null` — no matching term, and no number may be filled in. */
  column: number | null;
  confidence: 'confirmed' | 'inferred' | 'unknown';
  /** How the term was matched: "term 49 — ATK". */
  via: string;
  cost?: number;
}

export interface RosterEntry {
  key: string;
  rosterName: string | null;
  level: number;
  elite: number;
  /** The same level is also possible at a higher elite. */
  eliteUncertain: boolean;
  potential: number;
  skills: { basic: number; battle: number; combo: number; ultimate: number };
  weapon: RosterWeapon | null;
  gear: Array<{ slot: number; name: string | null; set: string | null }>;
  provenance: Record<string, Provenance>;
  /** Unlocked talent nodes from the showcase (`TalentNodes`). Missing — every tier the elite allows. */
  talentNodes?: TalentNodes;
}

/**
 * Talent nodes are unlocked one by one (gifts to the operator), apart from
 * elite: `attribute` — open tiers of the attribute talent, `passive` — the
 * tier of each other talent in order (measurements, #59: Argent Flow at
 * Elite 4 with no attribute node had Will 60 below the elite's).
 */
export interface TalentNodes {
  attribute: number;
  passive: number[];
}

export interface Roster {
  operators: Record<string, RosterEntry>;
  defaults: Record<string, unknown>;
}
