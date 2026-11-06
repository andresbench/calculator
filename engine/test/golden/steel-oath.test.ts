/**
 * Golden test: Pogranichnik's Steel Oath — which steps spend a point, what
 * each point lands, under which buffs.
 *
 * Source — `docs/measurements.md`, #47 (2026-11-06). Pogranichnik's
 * ultimate on a fresh Rhodagn, then Chen: battle skill, combo, battle
 * skill, battle skill, combo, combo. No crits. The builds are the
 * showcase's of that day, pinned here.
 *
 * | step | game |
 * |---|---|
 * | his ultimate (Advance) | 18,131 |
 * | Chen's first battle skill: Vulnerable instead of Lift | no Shieldguard |
 * | combo, battle skill, battle skill, combo | Harass 6,866 / 7,203 / 7,203 / 7,203 |
 * | the last combo | Decisive Assault 33,931, no fifth Harass |
 *
 * What it pins down: a Physical Status that became Vulnerable spends no
 * point; the last point lands Decisive Assault instead of a Harass; a
 * point's hit already has the buffs its own SP switched on — Thermite
 * Cutter's +8 % ATK and Frontiers' +16 % DMG (as Breach in #23), so the
 * first Harass is 6,866 and not 6,045.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simModifiersFor,
  simulate,
  trackDamage,
  type Build,
  type Bundle,
} from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

/** Within 0.1 %: the ultimate itself is 4 off (18,135). */
const RELATIVE = 0.001;

function gearOf(bundle: Bundle, names: string[]): Build['gear'] {
  return names.map((name) => ({ key: name, tier: bundle.gear.pieces[name]!.stats[0]!.values.length - 1 }));
}

describeWithBundle("Pogranichnik's Steel Oath (measurements, #47)", (bundle) => {
  const builds: Record<string, Build> = {
    Pogranichnik: {
      ...emptyBuild('Pogranichnik'),
      potential: 2,
      skills: { basic: 9, battle: 12, combo: 12, ultimate: 12 },
      weaponKey: 'Thermite Cutter',
      weaponColumns: { 'Will [L]': 9, 'ATK [L]': 9, 'Flow: Thermal Release': 4 },
      gear: gearOf(bundle, ['Frontiers Fiber Gloves', 'Deep Rampart Armor', 'Frontiers O2 Tube', 'Frontiers O2 Tube']),
      talentNodes: { attribute: 4, passive: [2, 2] },
    },
    'Chen Qianyu': {
      ...emptyBuild('Chen Qianyu'),
      potential: 5,
      skills: { basic: 11, battle: 12, combo: 12, ultimate: 12 },
      weaponKey: 'Glorious Memory',
      weaponColumns: { 'Agility [L]': 9, 'Critical Rate [L]': 9, 'Twilight: Lingering Glow': 8 },
      gear: gearOf(bundle, ['MI Security Gloves', 'Swordmancer Heavy Armor', 'Swordmancer Dagger', 'Swordmancer Flint']),
      talentNodes: { attribute: 4, passive: [2, 2] },
    },
  };
  const rotation = parseRot(
    'team: Pogranichnik, Chen Qianyu\nPogranichnik: ULT\nChen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: CS',
    buildAliases(bundle),
  );
  const team = teamOf(bundle, rotation.team, rotation.steps);
  // Chen's potentials and Frontiers cut her combo cooldown: without them the
  // last combo comes after Steel Oath's 30 s.
  const sim = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
    sp: bundle.sp ?? FALLBACK_SP,
    synergy: bundle.synergy,
    modifiers: simModifiersFor(bundle, team, (key) => builds[key]?.potential ?? 0),
  });
  const damage = trackDamage(
    bundle,
    { frames: sim.frames, length: sim.real, team: [...team.keys()] },
    (key) => builds[key] ?? emptyBuild(key),
    null,
  );
  const hits = (label: RegExp) =>
    damage.steps.map((step) => step.parts.filter((part) => part.by === 'Pogranichnik' && label.test(part.label)).map((part) => part.nonCrit));
  const near = (got: number | undefined, game: number) => {
    expect(got, `no hit for ${game}`).toBeDefined();
    expect(Math.abs(got! / game - 1), `${got!.toFixed(0)} vs ${game}`).toBeLessThanOrEqual(RELATIVE);
  };

  it('his ultimate', () => near(hits(/^Advance/)[0]![0], 18131));

  it('four Harass: none on the first Lift, which was Vulnerable instead', () => {
    const harass = hits(/^Harass/);
    expect(harass.map((step) => step.length)).toEqual([0, 0, 1, 1, 1, 1, 0]);
    [6866, 7203, 7203, 7203].forEach((game, at) => near(harass[at + 2]![0], game));
  });

  it('Decisive Assault on the fifth point, instead of a Harass', () => {
    const decisive = hits(/^Decisive Assault/);
    expect(decisive.map((step) => step.length)).toEqual([0, 0, 0, 0, 0, 0, 1]);
    near(decisive[6]![0], 33931);
  });

  it('the points recover 4 × 10 + 40 SP for him', () => {
    const sp = sim.frames.flatMap((frame) => frame.charges.map((charge) => charge.sp));
    expect(sp).toEqual([10, 10, 10, 10, 40]);
  });
});
