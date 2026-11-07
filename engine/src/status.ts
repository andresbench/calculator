/**
 * Stacks on the target: Vulnerable and Arts Inflictions.
 *
 * These are **not buffs with a duration**. They are counters that get spent,
 * and treating them as timed windows was the first version's mistake: the
 * track drew Lift and Vulnerable hanging over the whole rotation, when in
 * truth Crush eats them the moment it lands.
 *
 * Straight from the glossary:
 *
 * > Hitting an enemy for the first time with a skill with Physical Status
 * > applies **Vulnerable instead of** the actual Physical Status. A Vulnerable
 * > enemy can be Lifted and Knocked Down to add more Vulnerable stacks
 * > (up to 4). Hitting a Vulnerable enemy with Crush or Breach will
 * > **consume** the Vulnerable stacks.
 *
 * > Up to 4 stacks of Arts Inflictions **of the same Element** can be applied.
 *
 * > Status Level is the number of Vulnerable or Arts Infliction stacks
 * > (max 4) consumed when triggering a Physical Status or Arts Reaction.
 *
 * That last sentence is why the counters matter for damage and not just for
 * display: Status Level is what Crush and Breach multiply by, and it is the
 * count of stacks **consumed**, not the count standing on the target.
 */

export const MAX_STACKS = 4;

/**
 * The four elements that stack as Arts Inflictions.
 *
 * Deliberately not the same list as `ELEMENTS` in `stats.ts`: that one is
 * damage types and includes Physical and Aether, which never stack as
 * inflictions. Two lists with one name would be a bug waiting to happen.
 */
export const INFLICTION_ELEMENTS = ['Heat', 'Cryo', 'Electric', 'Nature'] as const;
export type ArtsElement = (typeof INFLICTION_ELEMENTS)[number];

/** Physical statuses that put Vulnerable stacks on. */
export const VULNERABILITY_BUILDERS = new Set(['Lift', 'Knock Down']);
/** Physical statuses that spend them. Status Level is how many they ate. */
export const VULNERABILITY_CONSUMERS = new Set(['Crush', 'Breach']);
/** Arts Reactions spend Arts Infliction stacks the same way. */
export const ARTS_REACTIONS = new Set([
  'Combustion',
  'Electrification',
  'Solidification',
  'Corrosion',
]);

/**
 * Arts Infliction lasts 20 seconds; a new stack of the same element resets
 * the timer (wiki, `Arts Infliction`).
 */
export const INFLICTION_SECONDS = 20;

/**
 * Infliction of a different element on a target that already has one
 * triggers a reaction. The **incoming** element names the reaction, the
 * standing stacks are consumed and give its Status Level (wiki, `Arts
 * Reaction`). Hence «Nature on Cryo → Corrosion, Cryo on Nature →
 * Solidification», as the arcane-corrosion rotation puts it.
 */
export const REACTION_OF: Record<ArtsElement, string> = {
  Heat: 'Combustion',
  Electric: 'Electrification',
  Cryo: 'Solidification',
  Nature: 'Corrosion',
};

/** A term that is a stack on the target, one that can be counted and eaten. */
export function isStackTerm(term: string): boolean {
  if (term === 'Vulnerable' || term === 'Arts Infliction' || term === 'Arts Reaction') return true;
  return inflictionElement(term) !== null || ARTS_REACTIONS.has(term);
}

/** `"Heat Infliction"` → `"Heat"`, anything else → `null`. */
export function inflictionElement(term: string): ArtsElement | null {
  const match = /^(Heat|Cryo|Electric|Nature) Infliction$/.exec(term);
  return match ? (match[1] as ArtsElement) : null;
}

/**
 * Terms that name a category or a stack rather than a timed debuff.
 *
 * `Vulnerable` is the stack itself, so it belongs on the counter, not in the
 * ribbon. `Physical Status`, `Arts Infliction` and `Susceptible` are genus
 * terms: the glossary uses them as umbrellas, and a trigger asking for one is
 * closed by any member. Drawn as windows they would duplicate the specific
 * term standing right next to them.
 */
export const UMBRELLA_TERMS = new Set([
  'Vulnerable',
  'Physical Status',
  'Arts Infliction',
  'Susceptible',
  'Status Level',
  'Debuff Consumption',
]);

export type StatusKind =
  | { kind: 'umbrella' }
  | { kind: 'buildsVulnerable' }
  | { kind: 'consumesVulnerable' }
  | { kind: 'infliction'; element: ArtsElement }
  | { kind: 'consumesInfliction' }
  | { kind: 'other' };

export function classify(term: string): StatusKind {
  if (UMBRELLA_TERMS.has(term)) return { kind: 'umbrella' };
  if (VULNERABILITY_BUILDERS.has(term)) return { kind: 'buildsVulnerable' };
  if (VULNERABILITY_CONSUMERS.has(term)) return { kind: 'consumesVulnerable' };
  const element = inflictionElement(term);
  if (element) return { kind: 'infliction', element };
  if (ARTS_REACTIONS.has(term)) return { kind: 'consumesInfliction' };
  return { kind: 'other' };
}

/** What happened to the counters on one step. */
export interface StatusEvent {
  term: string;
  /** Who applied it: the status's damage is computed from them (measurements, #3, #25). */
  by?: string;
  /**
   * `debuffConsumed` — a debuff ended early (Originium Crystals broken),
   * `by` is whoever put it there and `consumer` whoever took it;
   * `reactionConsumed` — a skill took a reaction off the target by its own
   * text («then consumes the enemy's Solidification»): `by` and `consumer`
   * are the one who took it; no damage of its own;
   * `buffSpent` — Link spent by the cast.
   */
  kind: StatusKind['kind'] | 'debuffConsumed' | 'reactionConsumed' | 'buffSpent' | 'markDetonated';
  consumer?: string;
  /** Stacks consumed — this is Status Level, and it drives the multiplier. */
  consumed?: number;
  element?: ArtsElement;
  /**
   * True when a Physical Status landed on a clean target and so applied
   * Vulnerable *instead of itself*.
   *
   * It matters beyond bookkeeping: in that case the status **produces no
   * damage instance at all**. The measurement log calls this out explicitly —
   * the first hit on a fresh boss and a hit inside a rotation are different
   * things and cannot be compared.
   */
  appliedVulnerableInstead?: boolean;
  /** A stack of the same element on top of a standing one is an Arts Burst (wiki, Arts Infliction). */
  burst?: boolean;
  /** A forced reaction: no initial hit, level I (wiki, Arts Reaction). */
  forced?: boolean;
  /** The status hit ×this: Crush on a target with Sunderization (`markDetonated` follows it). */
  boost?: number;
  /** `markDetonated`: the explosion's ATK share (stacks × per stack) and its bonus per point of AI. */
  multiplier?: number;
  aiPerPoint?: number;
  /** `markDetonated`: the explosion's element (not always an Arts one). */
  blastElement?: string;
  /**
   * World time it happened, when that is not the step's start: a background
   * battle skill's hit landing during another step (measurements, #63).
   */
  at?: number;
}

/**
 * Terms whose duration row the wiki labels by another name. The crystals are
 * the seal: `Seal Duration (s)` on the Endministrator's combo, and they go
 * when it goes (measurements, #9).
 */
const DURATION_LABEL: Record<string, string> = { 'Originium Crystal': 'Seal' };

/**
 * Rows whose label does not name the term but which are its duration, by
 * measurement. Lifeng's combo `Combo Duration (s)` = 20 is the Link it
 * leaves on the team: the icon goes away on its own after 20 s
 * (measurements, #41). No other skill has such a row.
 */
const DURATION_ROW: Record<string, RegExp> = { Link: /^Combo Duration\b/i };

/**
 * Duration of an applied term, if the skill's own stats name one.
 *
 * The wiki labels these per term: `Lift Duration (s)`, `Physical
 * Susceptibility Duration (s)`, `Combustion Duration (s)`. A bare
 * `Duration (s)` is only usable when the skill touches exactly one term —
 * otherwise which term it refers to is a guess, and we return null instead
 * of guessing.
 */
export function durationForTerm(
  stats: Array<{ label: string; unit: string; values: number[] }>,
  term: string,
  terms: string[],
  level: number,
): number | null {
  const index = Math.min(Math.max(level, 1), 12) - 1;
  const label = DURATION_LABEL[term] ?? term;

  const named = stats.find(
    (stat) =>
      stat.unit === 'sec' &&
      new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b.*duration`, 'i').test(
        stat.label,
      ),
  );
  if (named) return named.values[index] ?? null;

  const row = DURATION_ROW[term];
  const measured = row && stats.find((stat) => stat.unit === 'sec' && row.test(stat.label));
  if (measured) return measured.values[index] ?? null;

  if (terms.length === 1 && terms[0] === term) {
    const bare = stats.find((stat) => stat.unit === 'sec' && /^duration/i.test(stat.label));
    if (bare) return bare.values[index] ?? null;
  }

  return null;
}
