/**
 * Golden test: the stat sheet matches the in-game stat screen — with weapon
 * and sets from the effects layer, no manual `extra`.
 *
 * Sources — `docs/measurements.md`:
 *
 * * #24 — Endministrator P4, `Grand Vision` (9/9/4), three `Grizzled Edge`
 *   pieces and `Swordmancer Heavy Armor T1`; the second screen is without
 *   `Grizzled Edge Gauntlets T1`, set 2/3. The ATK difference is exactly
 *   the set's `ATK +8 %`. P4 rather than the roster's P3: Arts Intensity
 *   64 = 48 weapon + 16 P4 (#27.2).
 * * #23 — Pogranichnik, `Thermite Cutter` (9/9/4), four `AIC Fieldwork`
 *   pieces; the second screen is without two `Ember`, set off. "DMG Dealt
 *   +20 % for all types" is spread over every element on the screen.
 * * #4 (F3) — Rossi with no gear and `Aspirant` lv. 1: every column first.
 *
 * Weapon, gear and columns are set here explicitly: the roster is a
 * showcase snapshot and goes stale. Attributes
 * and percentages come from the bundle. The screen truncates fractions,
 * hence a tolerance of one.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildStatsWithEffects,
  screenElementBonus,
  type BuildInput,
  type Bundle,
  type StatSheet,
} from '../../src/index.js';
import { bundle, describeWithBundle } from '../support/bundle.js';

const TOLERANCE = 1;


interface Setup {
  operator: string;
  level: number;
  elite: number;
  potential: number;
  weapon: string;
  weaponLevel: number;
  columns: Record<string, number>;
  /** Slots in order: gloves, armor, kit, kit. */
  gear: Array<string | null>;
}

function sheetOf(setup: Setup): StatSheet {
  const gear: BuildInput['gear'] = setup.gear.map((name) => {
    if (!name) return null;
    const piece = bundle!.gear.pieces[name];
    if (!piece) throw new Error(`no item ${name}`);
    return { piece, tier: piece.stats[0]!.values.length - 1 };
  });
  return buildStatsWithEffects(
    {
      operator: bundle!.operators[setup.operator]!,
      level: setup.level,
      weapon: { weapon: bundle!.weapons[setup.weapon]!, level: setup.weaponLevel, columns: setup.columns },
      gear,
    },
    bundle!.effects,
    { operator: setup.operator, elite: setup.elite, potential: setup.potential },
  ).sheet;
}

function near(actual: number, screen: number): void {
  expect(Math.abs(actual - screen), `${actual.toFixed(2)} vs screen ${screen}`).toBeLessThanOrEqual(TOLERANCE);
}

describeWithBundle("Endministrator's stat screen: Grizzled Edge ATK +8 % (measurements, #24)", () => {
  const full: Setup = {
    operator: 'Endministrator (female)',
    level: 90,
    elite: 4,
    potential: 4,
    weapon: 'Grand Vision',
    weaponLevel: 90,
    columns: { 'Agility [L]': 9, 'ATK [L]': 9, 'Infliction: Long Time Wish': 4 },
    gear: [
      'Grizzled Edge Gauntlets T1',
      'Swordmancer Heavy Armor T1',
      'Grizzled Edge Push Knife T1',
      'Grizzled Edge Push Knife T1',
    ],
  };
  const broken: Setup = { ...full, gear: [null, ...full.gear.slice(1)] };

  it.each([
    ['set 3/3', full, { ATK: 5765, AGL: 635, STR: 307, AI: 108, HP: 7030 }],
    ['set 2/3', broken, { ATK: 4848, AGL: 551, STR: 252, AI: 64, HP: 6755 }],
  ] as const)('%s', (_label, setup, screen) => {
    const sheet = sheetOf(setup);
    near(sheet.attack, screen.ATK);
    near(sheet.attributes.AGL, screen.AGL);
    near(sheet.attributes.STR, screen.STR);
    near(sheet.artsIntensity, screen.AI);
    near(sheet.hp, screen.HP);
  });

  it("the set's ATK % is in one group with the weapon's: 39 % + 8 %", () => {
    expect(sheetOf(full).attackPercent).toBeCloseTo(0.47, 10);
    expect(sheetOf(broken).attackPercent).toBeCloseTo(0.39, 10);
  });
});

describeWithBundle("Pogranichnik's stat screen: AIC Fieldwork and Thermite Cutter (measurements, #23)", () => {
  const full: Setup = {
    operator: 'Pogranichnik',
    level: 90,
    elite: 4,
    potential: 2,
    weapon: 'Thermite Cutter',
    weaponLevel: 90,
    columns: { 'Will [L]': 9, 'ATK [L]': 9, 'Flow: Thermal Release': 4 },
    gear: ['AIC Fieldwork Hands', 'AIC Fieldwork Plate', 'AIC Fieldwork Ember', 'AIC Fieldwork Ember'],
  };
  const broken: Setup = { ...full, gear: [full.gear[0]!, full.gear[1]!, null, null] };

  it('set 4/4: ATK 5988, Physical +30 %, other elements +20 %', () => {
    const sheet = sheetOf(full);
    near(sheet.attack, 5988);
    near(sheet.attributes.WIL, 646);
    near(sheet.attributes.AGL, 267);
    expect(screenElementBonus(sheet, 'Physical')).toBeCloseTo(0.3, 10);
    for (const element of ['Heat', 'Electric', 'Cryo', 'Nature']) {
      expect(screenElementBonus(sheet, element), element).toBeCloseTo(0.2, 10);
    }
    expect(sheet.finalDmgReduction).toBeCloseTo(0.1, 10);
  });

  it('set off: ATK 5432, Physical +10 %, elements 0', () => {
    const sheet = sheetOf(broken);
    near(sheet.attack, 5432);
    near(sheet.attributes.WIL, 576);
    near(sheet.attributes.AGL, 221);
    expect(screenElementBonus(sheet, 'Physical')).toBeCloseTo(0.1, 10);
    expect(screenElementBonus(sheet, 'Heat')).toBeCloseTo(0, 10);
  });

  it("weapon ATK % — 39 % from the stat and 16 % from the named effect (4/4)", () => {
    expect(sheetOf(full).attackPercent).toBeCloseTo(0.55, 10);
  });
});

describeWithBundle("Rossi's stat screen: Aspirant lv. 1, no gear (measurements, #4)", () => {
  const setup: Setup = {
    operator: 'Rossi',
    level: 90,
    elite: 4,
    potential: 0,
    weapon: 'Aspirant',
    weaponLevel: 1,
    columns: { 'Agility [M]': 1, 'Physical DMG [M]': 1, 'Twilight: Imposing Peak': 1 },
    gear: [null, null, null, null],
  };

  it('ATK 911, AGL 252, INT 118, Physical +4.4 %', () => {
    const sheet = sheetOf(setup);
    near(sheet.attack, 911);
    near(sheet.attributes.AGL, 252);
    near(sheet.attributes.INT, 118);
    expect(screenElementBonus(sheet, 'Physical')).toBeCloseTo(0.0444, 10);
  });
});
