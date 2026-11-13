/**
 * A hit deals the element its row names, not the operator's (audit В11).
 *
 * Estella is Cryo, but «Tremolo … dealing Physical DMG»: resistance and the
 * element-filtered bonuses follow the row's `element` (`export.py`,
 * `row_elements`), and a row without one falls back to the operator's.
 */

import { expect, it } from 'vitest';

import {
  activeEffects,
  analyse,
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  grantBuffs,
  parseRot,
  rowElement,
  simModifiersFor,
  simulate,
  type Build,
  type DummyState,
  type Granter,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const LEVEL_12: Granter['skills'] = { 'Basic Attack': 12, 'Battle Skill': 12, 'Combo Skill': 12, Ultimate: 12 };
const ENEMY = 'Blazemist Originium Slug';

describeWithBundle('row element', (bundle) => {
  const build = (key: string): Build => ({ ...emptyBuild(key), skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } });
  const dummy: DummyState = { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} };
  const against: DummyState = { ...dummy, enemyKey: ENEMY };
  const damage = (key: string, type: string, target = dummy, external: Parameters<typeof analyse>[3] = []) =>
    analyse(build(key), bundle, target, external)!.skills.find((row) => row.type === type)!.result.damage;

  it('the enemy reads as the test needs it: Physical 0.8, Cryo 1.0', () => {
    expect(bundle.enemies[ENEMY]!.resistances).toMatchObject({ Physical: 0.8, Cryo: 1 });
  });

  it("Estella's Tremolo takes the Physical resistance, Onomatopoeia the Cryo one", () => {
    expect(damage('Estella', 'Ultimate', against)).toBeCloseTo(damage('Estella', 'Ultimate') * 0.8, 6);
    expect(damage('Estella', 'Battle Skill', against)).toBeCloseTo(damage('Estella', 'Battle Skill'), 6);
  });

  it('a row without an element deals the operator’s', () => {
    const lastRite = bundle.operators['Last Rite']!;
    const combo = lastRite.skills.find((skill) => skill.type === 'Combo Skill')!;
    const row = combo.stats.find((stat) => stat.hit)!;
    expect(row.element).toBeUndefined();
    expect(rowElement(row, lastRite)).toBe('Cryo');
    const tremolo = bundle.operators.Estella!.skills.find((skill) => skill.type === 'Ultimate')!.stats.find((stat) => stat.hit)!;
    expect(rowElement(tremolo, bundle.operators.Estella!)).toBe('Physical');
  });

  it("her own combo's Physical Susceptibility raises her ultimate", () => {
    // Alesh's battle skill turns her Cryo Infliction into Solidification, which Distortion needs.
    const rotation = parseRot('team: Estella, Alesh\nEstella: BS\nAlesh: BS\nEstella: CS\nEstella: ULT', buildAliases(bundle));
    const members = teamOf(bundle, rotation.team, rotation.steps);
    const sim = simulate(rotation.steps, members, FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 1000 },
      ultimatesCharged: true,
      modifiers: simModifiersFor(bundle, members, () => 0),
    });
    const mods = (key: string) => activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0 }).flatMap((effect) => effect.grants ?? []);
    const grants = grantBuffs(bundle, sim.frames, [...members.keys()], (key) => ({ skills: LEVEL_12, attributes: {}, mods: mods(key) }));
    const standing = grants.before[3]!.filter((buff) => buff.apply.stat === 'susceptibility');
    expect(standing.map((buff) => [buff.receiver, buff.apply.element])).toEqual([['enemy', 'Physical']]);
    const value = standing[0]!.apply.value;
    expect(value).toBeGreaterThan(0);
    // Susceptibility is its own multiplier (1 + sum); her Cryo battle skill does not take it.
    expect(damage('Estella', 'Ultimate', dummy, standing) / damage('Estella', 'Ultimate')).toBeCloseTo(1 + value, 9);
    expect(damage('Estella', 'Battle Skill', dummy, standing)).toBe(damage('Estella', 'Battle Skill'));
  });
});
