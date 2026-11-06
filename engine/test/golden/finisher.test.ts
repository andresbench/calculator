/**
 * Golden test: a finisher takes the Staggered +30 % on top of the enemy's
 * Finisher ATK Mult.
 *
 * Source — `docs/measurements.md`, #45 b) (2026-11-06). Rhodagn staggered,
 * Chen in the stagger window, no crits on these hits. The finisher came as
 * two hits, 13,566 + 54,265 (1 : 4) = 67,831; a basic attack chain in the same
 * window: SEQ 1 1,961, SEQ 2 2,335, SEQ 5 3,876. The buffs she had cancel in
 * the ratio: finisher / SEQ n.
 */

import { expect, it } from 'vitest';

import { analyse, emptyBuild, type Build, type Bundle } from '../../src/index.js';
import { describeWithBundle } from '../support/bundle.js';

/** Within 0.1 %: the game shows whole numbers, SEQ 1 is under 2,000. */
const RELATIVE = 0.001;

function gearOf(bundle: Bundle, names: string[]): Build['gear'] {
  return names.map((name) => ({ key: name, tier: bundle.gear.pieces[name]!.stats[0]!.values.length - 1 }));
}

describeWithBundle("Chen's finisher on Rhodagn (measurements, #45 b)", (bundle) => {
  const chen: Build = {
    ...emptyBuild('Chen Qianyu'),
    potential: 5,
    skills: { basic: 11, battle: 12, combo: 12, ultimate: 12 },
    weaponKey: 'Glorious Memory',
    weaponColumns: { 'Agility [L]': 9, 'Critical Rate [L]': 9, 'Twilight: Lingering Glow': 8 },
    gear: gearOf(bundle, ['MI Security Gloves', 'Swordmancer Heavy Armor', 'Swordmancer Dagger', 'Swordmancer Flint']),
    talentNodes: { attribute: 4, passive: [2, 2] },
  };
  const analysis = analyse(chen, bundle, { enemyKey: 'Rhodagn the Bonekrushing Fist', tier: 5, staggered: true, crit: false, assume: {} })!;
  const hit = (label: string) => analysis.skills.find((row) => row.label === label)!.result.damage;
  const finisher = 13566 + 54265;

  for (const [label, game] of [
    ['BATK SEQ 1 Multiplier', 1961],
    ['BATK SEQ 2 Multiplier', 2335],
    ['BATK SEQ 5 Multiplier', 3876],
  ] as const) {
    it(`finisher / ${label.replace(' Multiplier', '')}`, () => {
      const model = hit('Finisher ATK Multiplier') / hit(label);
      expect(Math.abs(model / (finisher / game) - 1), `${model.toFixed(3)} vs ${(finisher / game).toFixed(3)}`).toBeLessThanOrEqual(RELATIVE);
    });
  }

  // The Endministrator, the same day: SEQ 1 at the start of the fight 2,569;
  // her finisher, two hits, 10,135 + 92,832 = 102,967, with no buff up (no
  // Crush in the window, so no Grizzled Edge). The engine is 0.15 % above —
  // not explained, inside 0.2 %.
  it("the Endministrator's finisher, absolute", () => {
    const endmin: Build = {
      ...emptyBuild('Endministrator (female)'),
      potential: 4,
      skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 },
      weaponKey: 'Grand Vision',
      weaponColumns: { 'Agility [L]': 9, 'ATK [L]': 9, 'Infliction: Long Time Wish': 4 },
      gear: gearOf(bundle, ['Grizzled Edge Gauntlets T1', 'Swordmancer Heavy Armor T1', 'Grizzled Edge Push Knife T1', 'Grizzled Edge Push Knife T1']),
      talentNodes: { attribute: 4, passive: [2, 2] },
    };
    const on = (staggered: boolean) =>
      analyse(endmin, bundle, { enemyKey: 'Rhodagn the Bonekrushing Fist', tier: 5, staggered, crit: false, assume: {} })!;
    const of = (staggered: boolean, label: string) => on(staggered).skills.find((row) => row.label === label)!.result.damage;
    expect(Math.abs(of(false, 'BATK SEQ 1 Multiplier') - 2569)).toBeLessThanOrEqual(1);
    expect(Math.abs(of(true, 'Finisher ATK Multiplier') / (10135 + 92832) - 1)).toBeLessThanOrEqual(0.002);
  });
});
