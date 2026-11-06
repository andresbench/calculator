/**
 * Golden test: the Stagger Chen deals, read off Rhodagn's gauge.
 *
 * Source — `docs/measurements.md`, #62 (2026-11-06). Rhodagn's gauge is 280
 * and does not drain during pauses; the video gives it in pixels, 1 px ≈ 0.59,
 * so one jump is good to two pixels. Chen in Swordmancer ×3 (Stagger
 * Efficiency +20 %, a hit with 10 Stagger once per 15 s), AI 26.
 *
 * | run | gauge jumps |
 * |---|---|
 * | a basic attack chain, twice | +18.8, +19.3 (only the Final Strike) |
 * | five battle skills | +11.8, +37.5, +24.9, +37.5, +25.2 |
 * | battle skill, combo, twice | +11.8, +25.8, +25.2, +13.4 |
 * | Pogranichnik's ultimate, then Chen's steps | Advance +10.1 … Decisive +14.6 with the last point |
 *
 * What it pins down: Stagger Efficiency scales every Stagger Chen deals (16
 * → 19.2, 10 → 12); Lift deals 10 × (1 + AI / 200), on a full Vulnerable
 * too, and none when it became Vulnerable on a clean target; the Swordmancer
 * hit adds its own 10, once per 15 s; Chen's combo deals none of its own;
 * Decisive Assault's 15 lands with the last Steel Oath point, Harass none.
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
  targetFor,
  type Build,
  type Bundle,
} from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

/** Two pixels of the gauge. */
const TOLERANCE = 1.2;

function gearOf(bundle: Bundle, names: string[]): Build['gear'] {
  return names.map((name) => ({ key: name, tier: bundle.gear.pieces[name]!.stats[0]!.values.length - 1 }));
}

describeWithBundle("Chen's Stagger on Rhodagn (measurements, #62)", (bundle) => {
  const builds: Record<string, Build> = {
    'Chen Qianyu': {
      ...emptyBuild('Chen Qianyu'),
      potential: 5,
      skills: { basic: 11, battle: 12, combo: 12, ultimate: 12 },
      weaponKey: 'Glorious Memory',
      weaponColumns: { 'Agility [L]': 9, 'Critical Rate [L]': 9, 'Twilight: Lingering Glow': 8 },
      gear: gearOf(bundle, ['MI Security Gloves', 'Swordmancer Heavy Armor', 'Swordmancer Dagger', 'Swordmancer Flint']),
      talentNodes: { attribute: 4, passive: [2, 2] },
    },
    Pogranichnik: {
      ...emptyBuild('Pogranichnik'),
      potential: 2,
      skills: { basic: 9, battle: 12, combo: 12, ultimate: 12 },
      weaponKey: 'Thermite Cutter',
      weaponColumns: { 'Will [L]': 9, 'ATK [L]': 9, 'Flow: Thermal Release': 4 },
      gear: gearOf(bundle, ['Frontiers Fiber Gloves', 'Deep Rampart Armor', 'Frontiers O2 Tube', 'Frontiers O2 Tube']),
      talentNodes: { attribute: 4, passive: [2, 2] },
    },
  };
  const target = targetFor(bundle, 'Rhodagn the Bonekrushing Fist', null);
  /** Gauge jumps per step, the stagger each step added. */
  const jumps = (script: string) => {
    const rotation = parseRot(script, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      sp: bundle.sp ?? FALLBACK_SP,
      synergy: bundle.synergy,
      target,
      ultimatesCharged: true,
      modifiers: simModifiersFor(bundle, team, (key) => builds[key]?.potential ?? 0, (key) => builds[key] ?? null),
    });
    let before = 0;
    return frames.map((frame) => {
      const added = frame.target.stagger - before;
      before = frame.target.stagger;
      return added;
    });
  };
  const near = (got: number[], game: Array<number | null>) => {
    expect(got.length).toBe(game.length);
    game.forEach((value, at) => {
      if (value == null) return;
      expect(Math.abs(got[at]! - value), `step ${at}: ${got[at]!.toFixed(1)} vs ${value}`).toBeLessThanOrEqual(TOLERANCE);
    });
  };

  it('the Final Strike: 16 × 1.2', () => {
    near(jumps('team: Chen Qianyu\nChen Qianyu: BA > FS'), [0, 18.8]);
  });

  it('five battle skills: the set hit on the 2nd and 4th, 15 s apart', () => {
    near(
      jumps(
        'team: Chen Qianyu\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: WAIT 1s\nChen Qianyu: BS\nChen Qianyu: WAIT 14s\nChen Qianyu: BS\nChen Qianyu: WAIT 9s\nChen Qianyu: BS',
      ).filter((_, at) => ![2, 4, 6].includes(at)),
      [11.8, 37.5, 24.9, 37.5, 25.2],
    );
  });

  it('battle skill and combo, twice: the combo deals only its Lift', () => {
    near(
      jumps('team: Chen Qianyu\nChen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: WAIT 11s\nChen Qianyu: BS\nChen Qianyu: CS').filter((_, at) => at !== 2),
      [11.8, 25.8, 25.2, 13.4],
    );
  });

  it("Pogranichnik's ultimate: Advance at the cast, Decisive Assault with the last point", () => {
    // Video 00-43-22. Chen's Lift steps there read up to 1.5 higher: Fervent
    // Morale from Pogranichnik's talent (+8 AI a stack), which the model does
    // not give her — those steps are not pinned here.
    const got = jumps(
      'team: Pogranichnik, Chen Qianyu\nPogranichnik: ULT\nChen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: CS',
    );
    near(got.slice(0, 3), [10.1, 11.5, 25.8]);
    // The last combo: its Lift and Decisive Assault's 15 together.
    expect(got[6]! - 15).toBeGreaterThan(12);
  });
});
