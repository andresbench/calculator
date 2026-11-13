/**
 * Golden test: «Skill DMG … (for every skill)» is battle skill, combo and
 * ultimate — not basic attacks.
 *
 * Source — `docs/measurements.md`, #38 (2026-11-05). Si (basic attack lv 9,
 * battle skill lv 10) on Rhodagn (resistance 0), no crit:
 *
 * | | ATK | Cryo DMG | skill-type bonus | SEQ 1 (one of two hits) | battle skill |
 * |---|---|---|---|---|---|
 * | three `Tide Surge` pieces | 3420 | +128.1 % | +20 % on BS / CS / ULT | 702 | 3648 |
 * | no gear | 3082 | +43.3 % | — | 398 | 1900 |
 *
 * Every hit is `ATK × multiplier × 0.5 × (1 + DMG bonus)`: SEQ 1 is 0.36
 * split over two hits of 0.18, the battle skill 0.86.
 */

import { expect, it } from 'vitest';

import { activeEffects, dmgBonusFor, type Bundle, type StatSheet } from '../../src/index.js';
import { describeWithBundle } from '../support/bundle.js';

/** The game shows whole numbers. */
const TOLERANCE = 1;
const DEFENSE = 0.5;

describeWithBundle('Skill DMG sets skip basic attacks (measurements, #38)', (bundle: Bundle) => {
  const tide = activeEffects(bundle.effects, { operator: 'Si', elite: 4, potential: 0, sets: { 'Tide Surge': 3 } });
  const skillTypeBonus = (type: string) =>
    tide
      .filter((effect) => effect.item === 'Tide Surge')
      .flatMap((effect) => effect.apply)
      .filter((apply) => apply.stat === 'dmg_bonus' && apply.skillType === type && apply.trigger == null)
      .reduce((sum, apply) => sum + Number(apply.value), 0);

  const sheet = (cryo: number, bySkillType: Record<string, number>) =>
    ({
      dmgBonus: { byElement: { Cryo: cryo }, arts: 0, bySkillType, allSkill: 0, vsStaggered: 0, all: 0, bySkill: {} },
    }) as unknown as StatSheet;

  it('the set layout gives the skills +20 % and the basic attack nothing', () => {
    expect(skillTypeBonus('Battle Skill')).toBeCloseTo(0.2, 10);
    expect(skillTypeBonus('Combo Skill')).toBeCloseTo(0.2, 10);
    expect(skillTypeBonus('Ultimate')).toBeCloseTo(0.2, 10);
    expect(skillTypeBonus('Basic Attack')).toBe(0);
  });

  it('the four measured hits', () => {
    const worn = sheet(1.281, {
      'Battle Skill': skillTypeBonus('Battle Skill'),
      'Combo Skill': skillTypeBonus('Combo Skill'),
      Ultimate: skillTypeBonus('Ultimate'),
    });
    const bare = sheet(0.433, {});
    const hit = (atk: number, multiplier: number, s: StatSheet, skillType: 'Basic Attack' | 'Battle Skill') =>
      atk * multiplier * DEFENSE * (1 + dmgBonusFor(s, { element: 'Cryo', skillType }));
    expect(Math.abs(hit(3420, 0.18, worn, 'Basic Attack') - 702)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(hit(3082, 0.18, bare, 'Basic Attack') - 398)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(hit(3420, 0.86, worn, 'Battle Skill') - 3648)).toBeLessThanOrEqual(TOLERANCE + 1);
    expect(Math.abs(hit(3082, 0.86, bare, 'Battle Skill') - 1900)).toBeLessThanOrEqual(TOLERANCE + 1);
  });

  it('«All Skill DMG» from gear skips basic attacks too', () => {
    const s = { dmgBonus: { byElement: {}, arts: 0, bySkillType: {}, allSkill: 0.3, vsStaggered: 0, all: 0, bySkill: {} } } as unknown as StatSheet;
    expect(dmgBonusFor(s, { element: 'Physical', skillType: 'Basic Attack' })).toBe(0);
    expect(dmgBonusFor(s, { element: 'Physical', skillType: 'Ultimate' })).toBeCloseTo(0.3, 10);
  });
});
