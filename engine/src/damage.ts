/**
 * The Arknights: Endfield damage formula.
 *
 * Source: the `Damage calculation` page (revid 59795) plus the
 * `Calculations` sections of ten mechanic pages. Checked by measurements —
 * which ones is stated for each multiplier in its `evidence` field.
 *
 * The defining property of this module: it returns not a number but a
 * **breakdown**. Every multiplier is named, with where it comes from and
 * how far it can be trusted. The UI shows the whole breakdown, so "why this
 * damage" never requires reading the code.
 *
 * The order of multipliers is copied from the wiki verbatim. It only matters
 * for reading: multiplication commutes, and the order does not change the
 * result.
 */

import type { Message } from './messages.js';

/** How far a number can be trusted. Reaches the UI unchanged. */
export type Confidence = 'confirmed' | 'inferred' | 'unknown';

/** What produced a damage instance: hidden multipliers depend on it. */
export type InstanceKind =
  | 'skill' // ordinary skill damage: the multiplier is written into the skill
  | 'physicalStatus' // Lift, Knock Down, Crush, Breach
  | 'artsBurst'
  | 'artsReaction'
  | 'shatter'
  | 'dot'; // damage over time: cannot crit

/** Which factor of the formula this is: a stable code, for labels in any language. */
export type FactorId =
  | 'attack'
  | 'skillMultiplier'
  | 'dmgBonus'
  | 'crit'
  | 'amp'
  | 'staggered'
  | 'finisher'
  | 'link'
  | 'weaken'
  | 'susceptibility'
  | 'dmgTaken'
  | 'dmgReduction'
  | 'protect'
  | 'defense'
  | 'resistance'
  | 'multiplicative'
  | 'level'
  | 'artsIntensity';

export interface Factor {
  id: FactorId;
  /** English label, for the CLI and tests; the app labels by `id`. */
  name: string;
  value: number;
  confidence: Confidence;
  /** What confirms it, or why it is in doubt. */
  evidence?: Message;
}

export interface DamageInput {
  /** Final attack, already assembled: see `stats.ts`. */
  attack: number;
  /** Skill multiplier at its level, as a fraction: 380 % → 3.8. */
  baseMultiplier: number;
  kind: InstanceKind;

  /** Σ of every "DMG Bonus" and "DMG Dealt" — they are one group. */
  dmgBonus?: number;
  /** Critical damage as a fraction. `null` — compute a non-crit hit. */
  critDmg?: number | null;
  /** Σ Amp. */
  amp?: number;
  staggered?: boolean;
  /**
   * The enemy's Finisher ATK Mult on a finisher hit: 1 / 1.25 / 1.5 / 1.75 by
   * tier, four enemies are exceptions (measurements, #18). 1 for any other hit.
   */
  finisherMultiplier?: number;
  /** Ready Link value: battle skill 0.30–0.75, ultimate 0.20–0.50. */
  link?: number;
  /** Each Weaken multiplies: Π (1 − w). */
  weaken?: number[];
  susceptibility?: number;
  /** Σ «DMG Taken»: Breach, Electrification, Realspace Stasis. */
  increasedDmgTaken?: number;
  dmgReduction?: number[];
  /** Of all Protects, only the strongest applies. */
  protect?: number[];
  /** Target DEF. Every enemy in the game has 100 at any level. */
  def?: number;
  /** Resistance multiplier: 1.0 — no resistance, 0.8 — 20 % resistance. */
  resistance?: number;
  /** Where the resistance came from: `confirmed` — checked against the client at bundle export. */
  resistanceConfidence?: Confidence;
  ignoreRes?: number;
  corrosionShred?: number;
  multiplicative?: number[];

  /** The applying operator's level: a hidden multiplier. */
  operatorLevel?: number;
  /** Arts Intensity of the **applier**, not of the target or the team. */
  artsIntensity?: number;
}

export interface DamageResult {
  damage: number;
  factors: Factor[];
  /** The worst confidence among multipliers other than one. */
  confidence: Confidence;
  notes: Message[];
}

const CONFIDENCE_ORDER: Record<Confidence, number> = {
  confirmed: 0,
  inferred: 1,
  unknown: 2,
};

/**
 * DEF multiplier.
 *
 * Every enemy in the game has DEF 100 at any level, which gives exactly 0.5.
 * The wiki's negative-DEF branch is there for shred below zero.
 */
export function defenseMultiplier(def: number): number {
  if (def >= 0) return 100 / (def + 100);
  return 2 - Math.pow(0.99, -def);
}

/**
 * The hidden operator level multiplier.
 *
 * The game never mentions it — exactly the kind of mechanic this project
 * exists for. The divisor differs: 392 for Physical Status, 196 for
 * everything "arts", so level affects the latter twice as much.
 */
export function levelMultiplier(kind: InstanceKind, level: number): number {
  switch (kind) {
    case 'physicalStatus':
      return 1 + (level - 1) / 392;
    case 'artsBurst':
    case 'artsReaction':
    case 'shatter':
      return 1 + (level - 1) / 196;
    default:
      return 1;
  }
}

/**
 * Whether an instance scales with Arts Intensity.
 *
 * The boundary, established by measurement on 2026-09-04: **an instance the
 * system produces scales; damage written into a skill multiplier does
 * not.** Checked on three numbers that did not move by a single point when
 * AI changed: Chen's battle skill, the own hit of Endministrator's combo,
 * and the crystal shards (measurements, #1–#3).
 */
export function scalesWithArtsIntensity(kind: InstanceKind): boolean {
  return kind !== 'skill';
}

function product(values: number[] | undefined, transform: (v: number) => number): number {
  if (!values || values.length === 0) return 1;
  return values.reduce((accumulator, value) => accumulator * transform(value), 1);
}

/**
 * Computes one damage instance and returns its breakdown.
 *
 * Multipliers equal to one are left out of the breakdown: the list should
 * read as an explanation, not as a dump of every field.
 */
export function computeDamage(input: DamageInput): DamageResult {
  const factors: Factor[] = [];
  const notes: Message[] = [];

  const push = (
    id: FactorId,
    name: string,
    value: number,
    confidence: Confidence = 'confirmed',
    evidence?: Message,
  ): void => {
    if (value === 1) return;
    factors.push(evidence === undefined ? { id, name, value, confidence } : { id, name, value, confidence, evidence });
  };

  push('attack', 'Attack', input.attack, 'confirmed', { code: 'evAttack' });
  push('skillMultiplier', 'skill multiplier', input.baseMultiplier);

  push('dmgBonus', 'DMG Bonus', 1 + (input.dmgBonus ?? 0), 'confirmed', { code: 'evDmgBonus' });

  if (input.kind === 'dot') {
    if (input.critDmg != null) notes.push({ code: 'noteDotNoCrit' });
  } else if (input.critDmg != null) {
    push('crit', 'critical hit', 1 + input.critDmg);
  }

  push('amp', 'Amp', 1 + (input.amp ?? 0));

  if (input.staggered) {
    push('staggered', 'target staggered', 1.3, 'confirmed', { code: 'evStaggered' });
  }

  push('finisher', 'finisher multiplier', input.finisherMultiplier ?? 1);

  push('link', 'Link', 1 + (input.link ?? 0));

  push('weaken', 'Weaken', product(input.weaken, (w) => 1 - w), 'unknown', { code: 'evWeaken' });

  push('susceptibility', 'Susceptibility', 1 + (input.susceptibility ?? 0));

  push('dmgTaken', 'increased DMG taken', 1 + (input.increasedDmgTaken ?? 0), 'confirmed', { code: 'evDmgTaken' });

  push('dmgReduction', 'DMG reduction', product(input.dmgReduction, (r) => 1 - r));

  const protect = input.protect && input.protect.length > 0 ? Math.max(...input.protect) : 0;
  push('protect', 'Protect', 1 - protect, 'confirmed', { code: 'evProtect' });

  const def = input.def ?? 100;
  push('defense', 'target defense', defenseMultiplier(def), 'confirmed', { code: 'evDefense' });

  const resistance = (input.resistance ?? 1) + (input.ignoreRes ?? 0) + (input.corrosionShred ?? 0);
  const resistanceConfidence = input.resistanceConfidence ?? 'inferred';
  push('resistance', 'target resistance', resistance, resistanceConfidence, {
    code: resistanceConfidence === 'confirmed' ? 'evResistConfirmed' : 'evResistInferred',
  });

  push('multiplicative', 'multiplicative bonuses', product(input.multiplicative, (m) => 1 + m));

  // --- two multipliers beyond the common formula ---

  if (input.operatorLevel != null) {
    const level = levelMultiplier(input.kind, input.operatorLevel);
    push('level', 'hidden level multiplier', level, 'confirmed', {
      code: input.kind === 'physicalStatus' ? 'evLevelPhysical' : 'evLevel',
    });
  } else if (input.kind !== 'skill') {
    notes.push({ code: 'noteNoLevel' });
  }

  if (scalesWithArtsIntensity(input.kind)) {
    push('artsIntensity', 'Arts Intensity', 1 + (input.artsIntensity ?? 0) / 100, 'confirmed', {
      code: 'evArtsIntensity',
    });
  } else if (input.artsIntensity) {
    notes.push({ code: 'noteArtsIntensityIgnored' });
  }

  const damage = factors.reduce((accumulator, factor) => accumulator * factor.value, 1);
  const confidence = factors.reduce<Confidence>(
    (worst, factor) =>
      CONFIDENCE_ORDER[factor.confidence] > CONFIDENCE_ORDER[worst] ? factor.confidence : worst,
    'confirmed',
  );

  return { damage, factors, confidence, notes };
}

// ------------------------------------------------- base multipliers

/**
 * Base multiplier of a system-produced instance.
 *
 * `statusLevel` is the number of Vulnerable or Arts Infliction stacks
 * **consumed**, at most 4. This is not the number of stacks on the target:
 * as many are consumed as there were at the moment of triggering.
 */
export const STATUS_BASE: Record<
  string,
  { base: number; perStack: number; note?: string }
> = {
  Lift: { base: 1.2, perStack: 0 },
  'Knock Down': { base: 1.2, perStack: 0 },
  Crush: { base: 1.5, perStack: 1.5, note: '300 / 450 / 600 / 750 % by Status Level I–IV' },
  Breach: { base: 0.5, perStack: 0.5, note: '100 / 150 / 200 / 250 % by Status Level' },
  'Arts Burst': { base: 1.6, perStack: 0, note: 'does not depend on the number of Inflictions' },
  'Arts Reaction': { base: 0.8, perStack: 0.8 },
  Shatter: { base: 1.2, perStack: 1.2 },
  Combustion: { base: 0.12, perStack: 0.12, note: 'damage over time, cannot crit' },
};

export function statusMultiplier(effect: string, statusLevel = 0): number | null {
  const row = STATUS_BASE[effect];
  if (!row) return null;
  return row.base + row.perStack * statusLevel;
}

/**
 * The Breach debuff: how much more physical damage the target takes.
 *
 * Table from the `Breach` page, at base Strength. Goes into
 * `increasedDmgTaken`, i.e. it adds up with other "DMG Taken" effects and
 * multiplies with the `DMG Bonus` group.
 */
export const BREACH_DEBUFF: Record<number, { dmgTaken: number; duration: number }> = {
  1: { dmgTaken: 0.12, duration: 12 },
  2: { dmgTaken: 0.16, duration: 18 },
  3: { dmgTaken: 0.2, duration: 24 },
  4: { dmgTaken: 0.24, duration: 30 },
};

/**
 * Stagger from Lift and Knock Down.
 *
 * The only place where Arts Intensity is divided by 200 rather than 100.
 * The base of 10 is from the `Lift` page.
 */
export function liftStagger(artsIntensity: number, base = 10): number {
  return base * (1 + artsIntensity / 200);
}
