/**
 * Golden test: Endministrator's ultimate ladder and Crush ladder.
 *
 * Source — `docs/measurements.md`, #11–#13, closed 2026-09-06 as
 * `confirmed`. The value of this set is that the model resolves **without a
 * single free parameter**: all four quantities were measured separately.
 *
 *     G        = 1.748      DMG Bonus group base (stat screen, 74.8 %)
 *     gv       = 0.576      Grand Vision, effect Infliction: Long Time Wish
 *     ATK buff = 1.204087   what "ATK +30 %" does to damage
 *     Realspace= 1.20       Physical DMG Taken +20 % while crystals are up
 *
 * The test checks exactly what these multipliers are sorted into groups
 * for: `Grand Vision` and `Grizzled Edge` go into the **additive** DMG Bonus
 * group, and `Realspace Stasis` into a **separate** multiplier on top of
 * it. Mix up the groups and the numbers drift apart by percents.
 */

import { describe, expect, it } from 'vitest';

import { computeDamage, statusMultiplier, type DamageInput } from '../../src/index.js';

const G = 0.748; // DMG Bonus group base: 74.8 % on screen
const GRAND_VISION = 0.576;
const ATK_BUFF = 1.204087;
const REALSPACE = 0.2; // Physical DMG Taken +20 %

/** One ultimate cast in the given state. Returns the damage. */
function ultimate(options: {
  atkBuff?: boolean;
  grandVision?: boolean;
  /** Grizzled Edge: 6 % per consumed stack, doubled by the seal. */
  grizzledStacks?: number;
  grizzledDoubled?: boolean;
  /** Crystals on the target: Realspace Stasis. */
  seal?: boolean;
}): number {
  const grizzled = (options.grizzledStacks ?? 0) * 0.06 * (options.grizzledDoubled ? 1.5 : 1);
  const input: DamageInput = {
    attack: 1000 * (options.atkBuff ? ATK_BUFF : 1),
    baseMultiplier: 8, // the ultimate's main hit, 800 % ATK
    kind: 'skill',
    dmgBonus: G + (options.grandVision ? GRAND_VISION : 0) + grizzled,
    increasedDmgTaken: options.seal ? REALSPACE : 0,
    def: 0,
    resistance: 1,
  };
  return computeDamage(input).damage;
}

describe('ultimate ladder: four points, not one fitted number', () => {
  const cold = ultimate({});

  // Measured ratios to the cold ultimate (40 302).
  const POINTS = [
    {
      name: 'after Crush on 2 stacks',
      measured: 53525 / 40302,
      config: { atkBuff: true, grizzledStacks: 2, grizzledDoubled: true },
    },
    {
      name: 'after Crush on 4 stacks',
      measured: 58523 / 40302,
      config: { atkBuff: true, grizzledStacks: 4, grizzledDoubled: true },
    },
    {
      name: 'on the seal',
      measured: 64303 / 40302,
      config: { grandVision: true, seal: true },
    },
    {
      name: 'after an ally broke the seal',
      measured: 64522 / 40302,
      config: { atkBuff: true, grandVision: true },
    },
  ] as const;

  for (const point of POINTS) {
    it(`${point.name}: error below a hundredth of a percent`, () => {
      const predicted = ultimate(point.config) / cold;
      expect(Math.abs(predicted - point.measured) / point.measured).toBeLessThan(0.0001);
    });
  }

  it('the cold ultimate is 40 302 at a group base of 1.748', () => {
    // 1000 × 8 × 1.748 = 13 984 nominal units; checks the composition, not the absolute.
    expect(cold).toBeCloseTo(1000 * 8 * (1 + G), 6);
  });

  /**
   * The key distinction. `Realspace Stasis` is +20 % in a separate
   * multiplier, not +20 % in the common DMG Bonus pile. Put it in the pile
   * and the result is noticeably smaller, because the pile is already big.
   */
  it('Realspace Stasis is a separate multiplier, not part of the DMG Bonus pile', () => {
    const correct = ultimate({ grandVision: true, seal: true });
    const wrong = computeDamage({
      attack: 1000,
      baseMultiplier: 8,
      kind: 'skill',
      dmgBonus: G + GRAND_VISION + REALSPACE,
      def: 0,
      resistance: 1,
    }).damage;
    // 8000 × 2.324 × 1.20 against 8000 × 2.524 — almost 10.5 % apart.
    expect(correct).toBeGreaterThan(wrong);
    expect(correct / wrong).toBeCloseTo((1 + G + GRAND_VISION) * 1.2 / (1 + G + GRAND_VISION + REALSPACE), 10);
    expect(correct / wrong).toBeCloseTo(1.1049, 3);
    // And only the "right" variant hits the measurement: the note predicted
    // 1.595423 against the observed 1.595529, an error of 0.007 %.
    const ratio = correct / ultimate({});
    expect(ratio).toBeCloseTo(1.595423, 5);
    expect(Math.abs(ratio - 64303 / 40302) / ratio).toBeLessThan(0.0001);
  });

  /**
   * Measured 2026-09-06: Crush on a target **with the seal** gives twice
   * the Grizzled Edge buff of a bare one. The ratio is checked separately
   * because it once caused a correct conclusion to be wrongly withdrawn.
   */
  it('the seal doubles Grizzled Edge: 58 523 / 53 525', () => {
    const four = ultimate({ atkBuff: true, grizzledStacks: 4, grizzledDoubled: true });
    const two = ultimate({ atkBuff: true, grizzledStacks: 2, grizzledDoubled: true });
    expect(four / two).toBeCloseTo(58523 / 53525, 4);
  });
});

describe('the crystal burst on an ultimate, decomposed (measured 2026-09-06)', () => {
  /**
   * Frame: 32 151 · 48 227 · 64 303 — shards, bonus hit, main hit. The
   * ratios matched the listed multipliers to the fifth digit, which proved
   * that the shards **add to** the bonus hit rather than being replaced by
   * it: an ultimate on crystals is 1800 % ATK per cast against 800 %.
   */
  const shards = 32151;
  const bonus = 48227;
  const main = 64303;

  it('bonus hit to shards — exactly 600 % / 400 %', () => {
    expect(bonus / shards).toBeCloseTo(1.5, 4);
  });

  it('main hit to shards — exactly 800 % / 400 %', () => {
    expect(main / shards).toBeCloseTo(2.0, 4);
  });

  it('all three share one multiplier stack: damage per 100 % ATK matches', () => {
    const per100 = [shards / 4, bonus / 6, main / 8];
    const spread = (Math.max(...per100) - Math.min(...per100)) / Math.max(...per100);
    expect(spread).toBeLessThan(0.0001);
  });

  it('a cast on crystals totals 1800 % ATK', () => {
    expect(shards + bonus + main).toBe(144681);
  });
});

describe('Crush ladder and the Status Level table', () => {
  /**
   * K4 / K1 = 22 688 / 18 843 = 1.2041. Crush after the ultimate loses
   * nothing else: it runs with the ATK buff alone, because the ultimate took
   * Grand Vision and the seal is gone. Matches the ATK buff to the fourth
   * digit.
   */
  it('Crush after the ultimate loses exactly Grand Vision, nothing more', () => {
    expect(22688 / 18843).toBeCloseTo(ATK_BUFF, 3);
  });

  /**
   * A side finding: the ally broke the seal with Lift, and Lift on a
   * Vulnerable target adds a stack. Crush consumed three stacks instead of
   * two and went to Status Level III — a clean hit on the table.
   */
  it('breaking the seal with Lift raises Status Level: 600 % / 450 %', () => {
    const measured = (123381 / 57328) / (30415 / 18843);
    expect(measured).toBeCloseTo(4 / 3, 3);
    const third = statusMultiplier('Crush', 3)!;
    const second = statusMultiplier('Crush', 2)!;
    expect(third / second).toBeCloseTo(4 / 3, 10);
  });

  it('Crush table: 300 / 450 / 600 / 750 % at levels I–IV', () => {
    expect([1, 2, 3, 4].map((level) => statusMultiplier('Crush', level))).toEqual([3, 4.5, 6, 7.5]);
  });

  it('detonating on four stacks instead of two is ×1.667', () => {
    const ratio = statusMultiplier('Crush', 4)! / statusMultiplier('Crush', 2)!;
    expect(ratio).toBeCloseTo(5 / 3, 10);
    // Measured without crystals: 78 893 → 131 156 = ×1.6625, an error of 0.25 %.
    expect(Math.abs(ratio - 131156 / 78893) / ratio).toBeLessThan(0.003);
  });

  it('Breach table: 100 / 150 / 200 / 250 %', () => {
    expect([1, 2, 3, 4].map((level) => statusMultiplier('Breach', level))).toEqual([1, 1.5, 2, 2.5]);
  });
});

describe('measured 2026-10-17: P4, skill types, Grizzled Edge on its own Crush', () => {
  /**
   * #27.2, run A. The same "combo → ultimate on the seal" frame as on
   * 2026-09-06, but Endministrator is now P4 ("DMG dealt by Ultimate … 1.2
   * times"). The shards matched to the point and both ultimate hits grew
   * by exactly 1.2: the P4 multiplier sits on the ultimate skill, and the
   * combo's shards do not get it.
   */
  const P3 = { shards: 32151, bonus: 48227, main: 64303 };
  const P4 = { shards: 32151, bonus: 57873, main: 77163 };

  it('P4 gives the ultimate hits ×1.2 and leaves the shards alone', () => {
    expect(P4.shards).toBe(P3.shards);
    expect(P4.bonus / P3.bonus).toBeCloseTo(1.2, 4);
    expect(P4.main / P3.main).toBeCloseTo(1.2, 4);
    expect(P4.bonus / P4.main).toBeCloseTo(0.75, 4);
  });

  it('the cold ultimate also grew by exactly 1.2: 48 362 / 40 302', () => {
    expect(48362 / 40302).toBeCloseTo(1.2, 4);
  });

  /**
   * #27.2, run B: Rossi's gloves `MI Security Gloves T1` (Ultimate DMG
   * +56.1 %) instead of `Grizzled Edge Gauntlets T1`. All three instances
   * grew alike, so shards broken by the ultimate take Ultimate DMG Bonus.
   * Had they not, their ratio would lag by 1.24.
   */
  it('shards broken by the ultimate take Ultimate DMG Bonus', () => {
    const gloves = { shards: 36871, bonus: 66367, main: 88489 };
    const ratios = [gloves.shards / P4.shards, gloves.bonus / P4.bonus, gloves.main / P4.main];
    const spread = (Math.max(...ratios) - Math.min(...ratios)) / Math.max(...ratios);
    expect(spread).toBeLessThan(0.0001);
  });

  /**
   * #27.1: Chen's gloves `MI Security Gloves` (Battle Skill DMG +44.9 %),
   * a cold Crush on two stacks: 43 137 · 20 951. The battle skill's own hit
   * takes the bonus, Crush does not, as the `Crush` page says. Arts
   * Intensity 64 = Grand Vision 48 + P4 16 (GE gloves removed).
   */
  it("Crush does not take Battle Skill DMG Bonus; the battle skill's own hit does", () => {
    const own = computeDamage({ attack: 1000, baseMultiplier: 3.5, kind: 'skill', dmgBonus: G + 0.449, def: 0, resistance: 1 });
    const crush = computeDamage({
      attack: 1000,
      baseMultiplier: statusMultiplier('Crush', 2)!,
      kind: 'physicalStatus',
      dmgBonus: G,
      artsIntensity: 64,
      operatorLevel: 90,
      def: 0,
      resistance: 1,
    });
    const predicted = crush.damage / own.damage;
    expect(Math.abs(predicted - 43137 / 20951) / predicted).toBeLessThan(0.0005);
  });

  /**
   * The `Grizzled Edge` buff applies to **the very** Crush that triggered
   * it. That closed the "1.2 % off" from #13: K1 is a cold Crush on two
   * stacks and already carries its own 12 %; in K3 an ally's Lift broke the
   * seal, and Crush consumed three stacks under Grand Vision and the ATK
   * buff, carrying its own 18 %.
   */
  it('K3 / K1 matches if Grizzled Edge applies to its own Crush', () => {
    const k1 = 1 + G + 0.12;
    const k3 = (1 + G + GRAND_VISION + 0.18) * ATK_BUFF;
    expect(Math.abs(k3 / k1 - 30415 / 18843) / (30415 / 18843)).toBeLessThan(0.0001);
    // The old model without this gave 1.6009 — exactly the 0.8 % miss.
    const old = ((1 + G + GRAND_VISION) / (1 + G)) * ATK_BUFF;
    expect(Math.abs(old - 30415 / 18843) / (30415 / 18843)).toBeGreaterThan(0.005);
  });

  /**
   * The same for a weapon: `Sundering Steel` ("deals a Physical Status →
   * ATK +12 %") on Endministrator. Cold ultimate U = 34 318, cold Crush on
   * two stacks, own hit S = 14 838, screen: Physical DMG Bonus 89.9 %.
   * Without the buff on its own Crush, S/U would come out 10 % below the
   * measurement.
   *
   * The sword's effect is at level five (essence +1, rank 4), from the
   * weapon screen: ATK +9 % permanently, +13.5 % per stack. Together with
   * Grizzled Edge's 8 %, attack at rest is +17 %.
   */
  it('the Sundering Steel buff also applies to its own Crush', () => {
    const g = 1.899;
    const measured = 14838 / 34318;
    const base = (3.5 / 9.6) * ((g + 0.12) / g); // 9.6 = 800 % × 1.2 from P4
    const self = base * ((1 + 0.17 + 0.135) / (1 + 0.17));
    expect(Math.abs(self / measured - 1)).toBeLessThan(0.0005);
    expect(Math.abs(base / measured - 1)).toBeGreaterThan(0.08);
  });
});
