/**
 * Fixture guard.
 *
 * The fixture `test/fixtures/chen.ts` holds numbers copied from the data by
 * hand. Numbers like these are easy to write down wrong from memory: on the
 * first attempt Chen's curves were copied "roughly" and gave AGL 18.762
 * instead of the data's 20.567. The tests would have passed while the
 * engine computed the wrong thing.
 *
 * So here the fixture is checked against the real bundle. The bundle is
 * generated and not versioned, so a fresh clone may lack it — then the test
 * is honestly marked skipped rather than inventing a pass.
 *
 * To build the bundle: `python3 tools/ef/export.py`.
 */


import { describe, expect, it } from 'vitest';

import { assertBundle, type Bundle } from '../src/index.js';
import { bundle, describeWithBundle } from './support/bundle.js';

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


describeWithBundle('the fixture matches the built bundle', () => {
  it("Chen's attribute curves match to the last digit", () => {
    const real = bundle!.operators[CHEN.key];
    expect(real).toBeDefined();
    expect(real!.attributes).toEqual(CHEN.attributes);
  });

  it("Chen's profile matches: attributes, class, element, crit", () => {
    const real = bundle!.operators[CHEN.key]!;
    expect(real.mainAttribute).toBe(CHEN.mainAttribute);
    expect(real.subAttribute).toBe(CHEN.subAttribute);
    expect(real.element).toBe(CHEN.element);
    expect(real.class).toBe(CHEN.class);
    expect(real.critRate).toBe(CHEN.critRate);
    expect(real.id).toBe(CHEN.id);
  });

  it('the weapon ATK curve matches', () => {
    const real = bundle!.weapons[SUNDERING_STEEL.key]!;
    expect(real.baseAttack).toEqual(SUNDERING_STEEL.baseAttack);
    expect(real.id).toBe(SUNDERING_STEEL.id);
  });

  for (const fixture of [
    QINGBO_HEAVY_ARMOR,
    SWORDMANCER_HEAVY_ARMOR,
    SWORDMANCER_TAC_GAUNTLETS,
    SWORDMANCER_FLINT,
    GRIZZLED_EDGE_GAUNTLETS_T1,
    GRIZZLED_EDGE_GAUNTLETS,
    FRONTIERS_ARMOR_T3,
    MORDVOLT_INSULATION_VEST,
  ]) {
    it(`gear «${fixture.name}»: stats and tiers match`, () => {
      const real = bundle!.gear.pieces[fixture.key];
      expect(real, `missing from the bundle: ${fixture.key}`).toBeDefined();
      expect(real!.stats).toEqual(fixture.stats);
      expect(real!.type).toBe(fixture.type);
      expect(real!.set).toBe(fixture.set);
      expect(real!.artifice).toBe(fixture.artifice);
      expect(real!.defense).toBe(fixture.defense);
    });
  }

  it('two flints give exactly 0.598 Physical DMG Bonus, as measured', () => {
    const flint = bundle!.gear.pieces[SWORDMANCER_FLINT.key]!;
    const tertiary = flint.stats.find((stat) => stat.slot === 'tertiary')!;
    const maxTier = tertiary.values[tertiary.values.length - 1]!;
    expect(tertiary.stat).toBe('Physical DMG Bonus');
    expect(2 * maxTier).toBeCloseTo(0.598, 10);
  });
});
