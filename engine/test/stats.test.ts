/**
 * The stat sheet: assembling attack, attributes and bonus groups.
 *
 * Not just the arithmetic is checked, but also the gear rules derived from
 * measurements — they are phrased as claims about numbers and so are
 * testable.
 */

import { describe, expect, it } from 'vitest';

import { buildStats, dmgBonusFor, type BuildInput } from '../src/index.js';

import {
  CHEN,
  FRONTIERS_ARMOR_T3,
  GRIZZLED_EDGE_GAUNTLETS,
  GRIZZLED_EDGE_GAUNTLETS_T1,
  MORDVOLT_INSULATION_VEST,
  QINGBO_HEAVY_ARMOR,
  SUNDERING_STEEL,
  SWORDMANCER_FLINT,
  SWORDMANCER_HEAVY_ARMOR,
  SWORDMANCER_TAC_GAUNTLETS,
} from './fixtures/chen.js';

/** Chen's kit from the 2026-09-04 measurement, everything at max tier. */
function chenBuild(overrides: Partial<BuildInput> = {}): BuildInput {
  return {
    operator: CHEN,
    level: 90,
    weapon: { weapon: SUNDERING_STEEL, level: 90 },
    gear: [
      { piece: SWORDMANCER_TAC_GAUNTLETS, tier: 3 },
      { piece: QINGBO_HEAVY_ARMOR, tier: 3 },
      { piece: SWORDMANCER_FLINT, tier: 3 },
      { piece: SWORDMANCER_FLINT, tier: 3 },
    ],
    ...overrides,
  };
}

describe('attributes and attribute bonus', () => {
  it('bare Chen at level 90: the curve is read from the data', () => {
    const sheet = buildStats({ operator: CHEN, level: 90 });
    expect(sheet.attributes.AGL).toBeCloseTo(171.762, 3);
    expect(sheet.attributes.STR).toBeCloseTo(106.654, 3);
    expect(sheet.attributes.ATK).toBe(297);
  });

  it('only the main and secondary attributes go into the bonus', () => {
    const sheet = buildStats({ operator: CHEN, level: 90 });
    // 1 + 0.005 × Agility + 0.002 × Strength. Intellect and Will take no part.
    // Attributes as integers, as on screen (measurements, #36).
    const expected = 1 + 0.005 * 171 + 0.002 * 106;
    expect(sheet.attributeBonus).toBeCloseTo(expected, 10);
  });

  it('a point of the main attribute is worth exactly 2.5 times the secondary', () => {
    const base = buildStats({ operator: CHEN, level: 90 });
    const withMain = buildStats({
      operator: CHEN,
      level: 90,
      extra: [{ attributes: { AGL: 100 }, source: 'test' }],
    });
    const withSub = buildStats({
      operator: CHEN,
      level: 90,
      extra: [{ attributes: { STR: 100 }, source: 'test' }],
    });
    const mainGain = withMain.attributeBonus - base.attributeBonus;
    const subGain = withSub.attributeBonus - base.attributeBonus;
    expect(mainGain / subGain).toBeCloseTo(2.5, 10);
  });

  it('foreign attributes give exactly nothing', () => {
    const base = buildStats({ operator: CHEN, level: 90 });
    const withIntellect = buildStats({
      operator: CHEN,
      level: 90,
      extra: [{ attributes: { INT: 1000, WIL: 1000 }, source: 'test' }],
    });
    expect(withIntellect.attributeBonus).toBe(base.attributeBonus);
    expect(withIntellect.attack).toBe(base.attack);
  });
});

describe('gear', () => {
  it('"Main Attribute" resolves to the given operator\'s attribute', () => {
    const sheet = buildStats(chenBuild());
    // Gloves 84 + armor 113 + two flints at 41 = 279 above the curve.
    expect(sheet.attributes.AGL).toBeCloseTo(171.762 + 84 + 113 + 41 + 41, 3);
    expect(sheet.attributes.STR).toBeCloseTo(106.654 + 55 + 75 + 27 + 27, 3);
  });

  it('two flints add up to 0.598 Physical DMG Bonus', () => {
    const sheet = buildStats(chenBuild());
    expect(sheet.dmgBonus.byElement.Physical).toBeCloseTo(0.598, 10);
  });

  it('third stats each land in their own bucket, not a common pile', () => {
    const sheet = buildStats(chenBuild());
    expect(sheet.ultGainEfficiency).toBeCloseTo(0.16, 10);
    expect(sheet.dmgBonus.bySkillType.Ultimate).toBeCloseTo(0.561, 10);
    expect(sheet.artsIntensity).toBe(0);
  });

  it('the armor swap changes exactly one value — Arts Intensity +26.9', () => {
    const qingbo = buildStats(chenBuild());
    const swordmancer = buildStats(
      chenBuild({
        gear: [
          { piece: SWORDMANCER_TAC_GAUNTLETS, tier: 3 },
          { piece: SWORDMANCER_HEAVY_ARMOR, tier: 3 },
          { piece: SWORDMANCER_FLINT, tier: 3 },
          { piece: SWORDMANCER_FLINT, tier: 3 },
        ],
      }),
    );
    // Exactly what made the measurement clean: attributes and attack did not move.
    expect(swordmancer.attack).toBeCloseTo(qingbo.attack, 10);
    expect(swordmancer.attributes).toEqual(qingbo.attributes);
    expect(swordmancer.dmgBonus).toEqual(qingbo.dmgBonus);
    expect(swordmancer.artsIntensity - qingbo.artsIntensity).toBeCloseTo(26.9, 10);
  });

  /** The same Chen kit with the armor replaced. */
  const withArmor = (armor: typeof QINGBO_HEAVY_ARMOR, extra?: BuildInput['extra']): BuildInput =>
    chenBuild({
      gear: [
        { piece: SWORDMANCER_TAC_GAUNTLETS, tier: 3 },
        { piece: armor, tier: 3 },
        { piece: SWORDMANCER_FLINT, tier: 3 },
        { piece: SWORDMANCER_FLINT, tier: 3 },
      ],
      ...(extra ? { extra } : {}),
    });

  it('"Secondary Attribute +13.5%" is a percent of the attribute, not 0.135 points', () => {
    const sheet = buildStats(withArmor(FRONTIERS_ARMOR_T3));
    // Strength: curve + gloves 55 + two flints at 27; the armor gives no Strength.
    expect(sheet.attributes.STR).toBeCloseTo((106.654 + 55 + 27 + 27) * 1.135, 3);
  });

  it('an attribute percent applies to the sum including talents', () => {
    const sheet = buildStats(withArmor(FRONTIERS_ARMOR_T3, [{ attributes: { STR: 10 } }]));
    expect(sheet.attributes.STR).toBeCloseTo((106.654 + 55 + 27 + 27 + 10) * 1.135, 3);
  });

  it('"Attack +16.2" is flat attack, not +1620 %', () => {
    const qingbo = buildStats(withArmor(QINGBO_HEAVY_ARMOR));
    const vest = buildStats(withArmor(MORDVOLT_INSULATION_VEST));
    expect(vest.attackFlat).toBeCloseTo(16.2, 10);
    expect(vest.attackPercent).toBeCloseTo(qingbo.attackPercent, 10);
  });

  it('gloves with a foreign main attribute lose more than half their value', () => {
    const own = buildStats(
      chenBuild({
        gear: [{ piece: GRIZZLED_EDGE_GAUNTLETS_T1, tier: 3 }, null, null, null],
      }),
    );
    const foreign = buildStats(
      chenBuild({
        gear: [{ piece: GRIZZLED_EDGE_GAUNTLETS, tier: 3 }, null, null, null],
      }),
    );
    const naked = buildStats({ operator: CHEN, level: 90, weapon: { weapon: SUNDERING_STEEL, level: 90 } });

    const ownGain = own.attack - naked.attack;
    const foreignGain = foreign.attack - naked.attack;
    expect(foreignGain).toBeLessThan(ownGain);
    // Own: 84 main + 55 secondary. Foreign: 84 goes to secondary, 55 to nowhere.
    expect(ownGain / foreignGain).toBeGreaterThan(2.9);
  });

  it("an item's tier is chosen explicitly and changes the values", () => {
    const low = buildStats(chenBuild({ gear: [{ piece: SWORDMANCER_FLINT, tier: 0 }, null, null, null] }));
    const high = buildStats(chenBuild({ gear: [{ piece: SWORDMANCER_FLINT, tier: 3 }, null, null, null] }));
    expect(low.dmgBonus.byElement.Physical).toBeCloseTo(0.23, 10);
    expect(high.dmgBonus.byElement.Physical).toBeCloseTo(0.299, 10);
  });
});

describe('attack', () => {
  it('adds operator and weapon ATK, then multiplies by the bonus', () => {
    const sheet = buildStats(chenBuild());
    expect(sheet.baseAttack).toBe(297 + 411);
    expect(sheet.attack).toBeCloseTo(sheet.baseAttack * sheet.attributeBonus, 6);
  });

  it('percent ATK is worth less than face value: +30 % gives less than ×1.30', () => {
    const plain = buildStats(chenBuild());
    const buffed = buildStats(chenBuild({ extra: [{ attackPercent: 0.3, source: 'talent' }] }));
    const ratio = buffed.attack / plain.attack;
    // With no other percentages the group is empty, so here it is exactly 1.30.
    expect(ratio).toBeCloseTo(1.3, 10);

    // But once percentages are already collected, the bonus dilutes — which
    // is exactly what explains the measured ×1.204 instead of ×1.30.
    const loaded = buildStats(chenBuild({ extra: [{ attackPercent: 0.5, source: 'already collected' }] }));
    const loadedPlus = buildStats(
      chenBuild({ extra: [{ attackPercent: 0.5, source: 'already collected' }, { attackPercent: 0.3, source: 'talent' }] }),
    );
    expect(loadedPlus.attack / loaded.attack).toBeCloseTo(1.8 / 1.5, 10);
    expect(loadedPlus.attack / loaded.attack).toBeLessThan(1.3);
  });

  it('warns when the weapon or gear is not set', () => {
    const sheet = buildStats({ operator: CHEN, level: 90 });
    expect(sheet.warnings.map((warning) => warning.code)).toContain('statsNoWeapon');
    expect(sheet.warnings.map((warning) => warning.code)).toContain('statsNoGear');
  });
});

describe('DMG Bonus group', () => {
  it('collects only what fits the instance', () => {
    const sheet = buildStats(chenBuild());
    const physicalUlt = dmgBonusFor(sheet, { element: 'Physical', skillType: 'Ultimate' });
    const physicalBattle = dmgBonusFor(sheet, { element: 'Physical', skillType: 'Battle Skill' });
    expect(physicalUlt).toBeCloseTo(0.598 + 0.561, 10);
    expect(physicalBattle).toBeCloseTo(0.598, 10);
  });

  it('"Arts DMG" does not reach physical damage', () => {
    const sheet = buildStats({
      operator: CHEN,
      level: 90,
      extra: [{ dmgBonus: { arts: 0.2 }, source: 'test' }],
    });
    expect(dmgBonusFor(sheet, { element: 'Physical' })).toBe(0);
    expect(dmgBonusFor(sheet, { element: 'Heat' })).toBeCloseTo(0.2, 10);
  });

  it('the bonus against Staggered applies only during a stun', () => {
    const sheet = buildStats({
      operator: CHEN,
      level: 90,
      extra: [{ dmgBonus: { vsStaggered: 0.294 }, source: 'test' }],
    });
    expect(dmgBonusFor(sheet, { element: 'Physical' })).toBe(0);
    expect(dmgBonusFor(sheet, { element: 'Physical', staggered: true })).toBeCloseTo(0.294, 10);
  });
});
