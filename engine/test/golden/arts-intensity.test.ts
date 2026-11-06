/**
 * Golden test: the Arts Intensity ladder.
 *
 * Source — `docs/measurements.md`, #3, closed 2026-09-04 as `confirmed`.
 * This is the cleanest measurement in the project, and here is why.
 *
 * Swap: `Qingbo Heavy Armor` → `Swordmancer Heavy Armor`. Both armors have
 * the same main and secondary stats (Agility 113, Strength 75); only the
 * third differs: Ultimate Gain Efficiency against Arts Intensity 26.9. So
 * **exactly one value** changes between configs.
 *
 * Built-in control: four other numbers in the frame (10 733, 12 751,
 * 23 505, 24 181) had to stay put — and did, across all three configs. The
 * shards, 24 181, stayed unchanged for five runs in a row.
 *
 * What the test checks: the `1 + AI/100` multiplier on instances the system
 * produces, and its absence on ordinary skill damage.
 */

import { describe, expect, it } from 'vitest';

import { computeDamage, liftStagger, type DamageInput } from '../../src/index.js';

/** Measured numbers. The first column is Chen's Arts Intensity. */
const LADDER = [
  { artsIntensity: 0, comboLift: 6321, battleLift: 8280, armor: 'Qingbo Heavy Armor' },
  { artsIntensity: 26.9, comboLift: 8022, battleLift: 10508, armor: 'Swordmancer Heavy Armor' },
  { artsIntensity: 71.8, comboLift: 10858, battleLift: 14221, armor: '+ Grizzled Edge Gauntlets T1' },
] as const;

/**
 * The Lift instance. Nothing but Arts Intensity changed in the measurement,
 * so it is folded into one "attack": the test checks the multiplier, not
 * the absolute.
 */
function lift(artsIntensity: number, attack: number): number {
  const input: DamageInput = {
    attack,
    baseMultiplier: 1,
    kind: 'physicalStatus',
    artsIntensity,
    def: 0,
    resistance: 1,
  };
  return computeDamage(input).damage;
}

/**
 * Predictions written down **before** the measurement, and the observed
 * numbers.
 *
 * Checked by two separate claims, and that is not pedantry: the first
 * answers "does the engine compute correctly", the second "how closely did
 * the model match the game". Lumped into one, you cannot tell which part
 * broke when the test goes red.
 */
const PREDICTIONS = [
  { instance: 'combo', ai: 26.9, base: 6321, predicted: 8021.3, observed: 8022, error: 0.7 },
  { instance: 'combo', ai: 71.8, base: 6321, predicted: 10859.5, observed: 10858, error: 1.5 },
  { instance: 'battle', ai: 26.9, base: 8280, predicted: 10507.3, observed: 10508, error: 0.7 },
  { instance: 'battle', ai: 71.8, base: 8280, predicted: 14225.0, observed: 14221, error: 4.0 },
] as const;

describe("Arts Intensity: Chen's ladder (measured 2026-09-04)", () => {
  for (const point of PREDICTIONS) {
    it(`${point.instance} Lift, AI ${point.ai}: the engine gives the predicted number`, () => {
      expect(lift(point.ai, point.base)).toBeCloseTo(point.predicted, 1);
    });

    it(`${point.instance} Lift, AI ${point.ai}: matches the game within ${point.error} points`, () => {
      const predicted = lift(point.ai, point.base);
      expect(Math.abs(predicted - point.observed)).toBeLessThanOrEqual(point.error + 0.05);
    });
  }

  it('the largest error across the ladder is 4 points out of 14 221', () => {
    const worst = Math.max(
      ...PREDICTIONS.map((point) => Math.abs(lift(point.ai, point.base) - point.observed)),
    );
    expect(worst).toBeLessThan(4.1);
    expect(worst / 14221).toBeLessThan(0.0003);
  });

  it('the multiplier is linear: 0 → 71.8 gives exactly 1.718', () => {
    const ratio = lift(71.8, 1) / lift(0, 1);
    expect(ratio).toBeCloseTo(1.718, 10);
  });

  it("the frame's control numbers do not move by a single point", () => {
    // 10 733, 12 751, 23 505 and 24 181 did not change across three configs.
    for (const control of [10733, 12751, 23505, 24181]) {
      const unchanged = LADDER.map((point) =>
        computeDamage({
          attack: control,
          baseMultiplier: 1,
          kind: 'skill',
          artsIntensity: point.artsIntensity,
          def: 0,
          resistance: 1,
        }).damage,
      );
      expect(new Set(unchanged).size).toBe(1);
    }
  });
});

describe('Arts Intensity does not touch ordinary skill damage', () => {
  /**
   * The boundary from the measurement: an instance the system produces
   * scales; damage written into a skill multiplier does not. Checked on
   * three numbers that did not move by a single point: Chen's battle skill
   * (23 505), the own hit of Endministrator's combo, and the crystal shards
   * (24 181).
   */
  const skill = (artsIntensity: number): number =>
    computeDamage({
      attack: 23505,
      baseMultiplier: 1,
      kind: 'skill',
      artsIntensity,
      def: 0,
      resistance: 1,
    }).damage;

  it("Chen's battle skill: 23 505 at any AI", () => {
    expect(skill(0)).toBe(23505);
    expect(skill(26.9)).toBe(23505);
    expect(skill(71.8)).toBe(23505);
  });

  it('the engine warns that the given AI was not applied', () => {
    const result = computeDamage({
      attack: 100,
      baseMultiplier: 1,
      kind: 'skill',
      artsIntensity: 26.9,
    });
    expect(result.notes.map((note) => note.code)).toContain('noteArtsIntensityIgnored');
  });
});

describe('Stagger from Lift', () => {
  /** The only place where Arts Intensity is divided by 200, not 100. */
  it('base 10 at zero AI', () => {
    expect(liftStagger(0)).toBe(10);
  });

  it('AI 200 doubles stagger', () => {
    expect(liftStagger(200)).toBe(20);
  });

  it('AI 71.8 gives 13.59', () => {
    expect(liftStagger(71.8)).toBeCloseTo(13.59, 2);
  });
});
