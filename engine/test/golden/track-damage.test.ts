/**
 * Golden test: the track's damage sum, end to end.
 *
 * `track-breach` and `track-buffs` check the pieces — which buffs stand,
 * how a status hits — by putting the formula together by hand. Here the
 * same measured frames go through `trackDamage`, the function the app's
 * track shows: builds in, a simulated rotation in, per-hit numbers out. A
 * slip anywhere between the frames and the sum (a buff on the wrong table,
 * a hit counted twice, a status missed) moves these numbers.
 *
 * Sources — `docs/measurements.md`:
 *
 * * #23, Pogranichnik's Breach: SEQ 1 7474, Breach 5023, SEQ 2 10 912
 *   (AIC Fieldwork ×4); 5737 · 3856 · 8376 with two pieces;
 * * #4, run F3, Rossi's combo SEQ 2 under Camille's buffs: 1537 (Beacon of
 *   Duty), 1755 (Beacon and Frontiers).
 *
 * The game shows non-crit numbers, so `nonCrit` is compared; `damage` is
 * the expected value the sum adds up.
 */

import { expect, it } from 'vitest';

import {
  emptyBuild,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  trackDamage,
  type Build,
  type Bundle,
} from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

/** Numbers from the game are integers: the screen and damage pop-ups truncate fractions. */
const TOLERANCE = 1;

const MAXED_SKILLS = { basic: 12, battle: 12, combo: 12, ultimate: 12 };

/** Every piece at its top tier, as on the measured screens. */
function gearOf(bundle: Bundle, names: Array<string | null>): Build['gear'] {
  return names.map((name) => {
    if (!name) return null;
    const piece = bundle.gear.pieces[name]!;
    return { key: name, tier: piece.stats[0]!.values.length - 1 };
  });
}

function play(bundle: Bundle, script: string, names: Record<string, string>, builds: Record<string, Build>) {
  const rotation = parseRot(script, new Map(Object.entries(names)));
  const team = teamOf(bundle, rotation.team, rotation.steps);
  const sim = simulate(rotation.steps, team, FALLBACK_TIMINGS, { synergy: bundle.synergy });
  const damage = trackDamage(
    bundle,
    { frames: sim.frames, length: sim.real, team: [...team.keys()] },
    (key) => builds[key] ?? emptyBuild(key),
    null,
  );
  return { sim, damage };
}

const near = (actual: number | undefined, game: number) =>
  expect(Math.abs((actual ?? Number.NaN) - game), `${actual?.toFixed(1)} vs ${game}`).toBeLessThanOrEqual(TOLERANCE);

describeWithBundle("Pogranichnik's Breach, summed on the track (measurements, #23)", (bundle) => {
  const FULL = ['AIC Fieldwork Hands', 'AIC Fieldwork Plate', 'AIC Fieldwork Ember', 'AIC Fieldwork Ember'];
  const pogranichnik = (gear: Array<string | null>): Build => ({
    ...emptyBuild('Pogranichnik'),
    potential: 2,
    skills: MAXED_SKILLS,
    weaponKey: 'Thermite Cutter',
    weaponLevel: 90,
    weaponColumns: { 'Will [L]': 9, 'ATK [L]': 9, 'Flow: Thermal Release': 4 },
    gear: gearOf(bundle, gear),
  });

  function run(gear: Array<string | null>) {
    const { damage } = play(
      bundle,
      'team: Chen, Pogranichnik\nChen: BS\nPogranichnik: BS',
      { chen: 'Chen Qianyu', pogranichnik: 'Pogranichnik' },
      { Pogranichnik: pogranichnik(gear) },
    );
    const step = damage.steps[1]!;
    const part = (label: string) => step.parts.find((item) => item.label.startsWith(label) && item.by === 'Pogranichnik');
    return { damage, step, part };
  }

  it('AIC ×4: 7474 · 5023 · 10 912', () => {
    const { part } = run(FULL);
    near(part('SEQ 1')?.nonCrit, 7474);
    near(part('Breach SL 1')?.nonCrit, 5023);
    near(part('SEQ 2')?.nonCrit, 10912);
  });

  it('AIC ×2, set off: 5737 · 3856 · 8376', () => {
    const { part } = run([FULL[0]!, FULL[1]!, null, null]);
    near(part('SEQ 1')?.nonCrit, 5737);
    near(part('Breach SL 1')?.nonCrit, 3856);
    near(part('SEQ 2')?.nonCrit, 8376);
  });

  it('the sum is its parts: steps, operators, DPS', () => {
    const { damage } = run(FULL);
    const steps = damage.steps.reduce((sum, step) => sum + step.total, 0);
    const parts = damage.steps.flatMap((step) => step.parts).reduce((sum, part) => sum + part.damage, 0);
    const operators = damage.byOperator.reduce((sum, row) => sum + row.damage, 0);
    expect(damage.total).toBeGreaterThan(0);
    expect(steps).toBeCloseTo(damage.total, 6);
    expect(parts).toBeCloseTo(damage.total, 6);
    expect(operators).toBeCloseTo(damage.total, 6);
    for (const part of damage.steps.flatMap((step) => step.parts)) {
      // Expected damage is never below the non-crit hit, and a status's crit is its own.
      expect(part.damage).toBeGreaterThanOrEqual(part.nonCrit);
    }
  });
});

describeWithBundle("Rossi's combo under Camille's buffs, summed on the track (measurements, #4)", (bundle) => {
  const builds: Record<string, Build> = {
    Camille: {
      ...emptyBuild('Camille'),
      weaponKey: 'Beacon of Duty',
      weaponLevel: 90,
      weaponColumns: { 'Efficacy: Fuel for the Torch': 6 },
      gear: gearOf(bundle, ['Frontiers Fiber Gloves', 'Frontiers Armor', 'Frontiers Comm', null]),
    },
    Rossi: {
      ...emptyBuild('Rossi'),
      skills: MAXED_SKILLS,
      weaponKey: 'Aspirant',
      weaponLevel: 1,
      weaponColumns: { 'Agility [M]': 1, 'Physical DMG [M]': 1, 'Twilight: Imposing Peak': 1 },
    },
  };

  function seq2(script: string) {
    const { sim, damage } = play(
      bundle,
      `team: Perlica, Camille, Rossi\n${script}`,
      { perlica: 'Perlica', camille: 'Camille', rossi: 'Rossi' },
      builds,
    );
    const index = sim.frames.findIndex((frame) => frame.step.actor === 'Rossi' && frame.step.sequence === 2);
    const step = damage.steps[index]!;
    return { step, buffs: step.buffs.map((buff) => buff.effect.id) };
  }

  it("Combustion: Beacon of Duty after Camille's Heat Susceptibility — 1537", () => {
    const { step, buffs } = seq2('Perlica: BS\nCamille: BS\nRossi: CS1 > CS2');
    expect(buffs).toContain('weapon.beacon-of-duty.efficacy-fuel-for-the-torch');
    const hits = step.parts.filter((part) => !part.status);
    expect(hits).toHaveLength(1);
    near(hits[0]?.nonCrit, 1537);
  });

  it("Electrification after Camille's combo: Beacon and Frontiers — 1755", () => {
    const { step, buffs } = seq2('Camille: BS > CS\nPerlica: BS\nRossi: CS1 > CS2');
    expect(buffs).toContain('gear-set.frontiers.frontiers');
    const hits = step.parts.filter((part) => !part.status);
    expect(hits).toHaveLength(1);
    near(hits[0]?.nonCrit, 1755);
  });
});
