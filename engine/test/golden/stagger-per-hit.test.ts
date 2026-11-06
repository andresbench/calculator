/**
 * Golden test: the Staggered +30 % is checked per hit.
 *
 * Source — `docs/measurements.md`, #45 (2026-11-06). Rhodagn brought to
 * nearly full by Pogranichnik's ultimate and Chen's steps, then Chen's
 * ultimate: its first slash (First Strike Stagger 15 × 1.2) broke the meter.
 * Six slashes: 8,859, 12,076, 18,953 (crit), 19,791 (crit), 13,194, 13,194.
 * They rise by 559 a talent stack (Slashing Edge, ATK +8 % per skill hit) up
 * to five; the first slash had two stacks. Without the bonus the second slash
 * would be 8,859 + 559 / 1.3 = 9,289; it is 12,076 = 9,289 × 1.300. The first
 * — the hit that broke the meter — is 8,859, without it.
 */

import { expect, it } from 'vitest';

import { buildAliases, emptyBuild, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, targetFor, trackDamage, type Bundle } from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

describeWithBundle('Staggered +30 % per hit (measurements, #45)', (bundle: Bundle) => {
  it('the measured slashes: the second is the first plus one talent stack, × 1.3', () => {
    const stack = (13194 - 12076) / 2 / 1.3;
    expect((8859 + stack) * 1.3).toBeCloseTo(12076, -1);
  });

  const play = (meter: number) => {
    const rotation = parseRot('team: Chen Qianyu\nChen Qianyu: ULT', buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const target = { ...targetFor(bundle, null), staggerMeter: meter, staggerRecovery: 10 };
    const sim = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      sp: bundle.sp ?? FALLBACK_SP,
      synergy: bundle.synergy,
      target,
      ultimatesCharged: true,
    });
    const damage = trackDamage(bundle, { frames: sim.frames, length: sim.real, team: [...team.keys()], target }, (key) => emptyBuild(key), null);
    return { frame: sim.frames[0]!, parts: damage.steps[0]!.parts };
  };

  it('the first slash fills the meter: it goes without the bonus, the other five and the final strike with it', () => {
    const { frame, parts } = play(15);
    expect(frame.brokenByFirstHit).toBe(true);
    const one = parts.find((part) => part.label === 'Slash Multiplier × 1')!;
    const five = parts.find((part) => part.label === 'Slash Multiplier × 5')!;
    expect(five.nonCrit / 5 / one.nonCrit).toBeCloseTo(1.3, 10);
    const final = parts.find((part) => part.label.startsWith('Final Strike'))!;
    const plain = play(1000).parts.find((part) => part.label.startsWith('Final Strike'))!;
    expect(final.nonCrit / plain.nonCrit).toBeCloseTo(1.3, 10);
  });

  it('the final strike fills it: no hit of the cast gets the bonus (Blitzcrash, 2026-11-05)', () => {
    const { frame, parts } = play(30);
    expect(frame.brokenByFirstHit).toBeUndefined();
    expect(frame.target.staggered).toBe(true);
    const plain = play(1000).parts;
    expect(parts.map((part) => part.nonCrit)).toEqual(plain.map((part) => part.nonCrit));
  });
});
