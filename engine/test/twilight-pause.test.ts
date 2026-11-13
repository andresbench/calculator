/**
 * Laevatain's Twilight window is paused by her own combo and is not
 * stretched by the combo's slowdown on top of it (audit 2026-11-12, В8): the
 * window does not tick while she casts, so a slowdown that lies inside the
 * cast has nothing to slow. One that falls outside a pause still does.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  statAt,
  timerEnd,
  type SimulateOptions,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('Twilight: pause against slowdown', (bundle) => {
  const run = (text: string, extra: SimulateOptions = {}) => {
    const rotation = parseRot(text, buildAliases(bundle));
    return simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
      unlimitedSp: true,
      ultimatesCharged: true,
      ...extra,
    });
  };
  /** The rotation with its pause tuned so that the step at `index` is pressed at `at` (a pause under a slowdown runs longer). */
  const pressedAt = (script: (wait: number) => string, index: number, at: number, base: number) => {
    const first = run(script(at - base));
    return run(script(at - base + (at - first.frames[index]!.world)));
  };
  const ultimate = bundle.operators.Laevatain!.skills.find((skill) => skill.type === 'Ultimate')!;
  const seconds = statAt(ultimate, ultimate.enhancedBasic!.window, 12)!;

  it('her combo pauses the window by its own length, and its slowdown inside the pause adds nothing', () => {
    const script = (wait: number) => `team: Laevatain\nLaevatain: ULT\nLaevatain: CS\nLaevatain: WAIT ${wait}s\nLaevatain: BA`;
    const probe = run(script(0));
    const [ult, combo] = probe.frames;
    expect(combo!.verdicts.get(`${combo!.step.index}:slows`)?.code).toBe('comboSlowsWorld');
    const said = combo!.verdicts.get(`${combo!.step.index}:enhancedPaused`);
    expect(said).toMatchObject({ code: 'enhancedBasicPaused' });
    const until = (said as { until: number }).until;
    expect(until).toBeCloseTo(ult!.world + seconds + combo!.duration, 9);
    // And the basic attack agrees with it: enhanced just before that moment, plain just after.
    const back = probe.frames[3]!.world;
    for (const [offset, enhanced] of [[-0.1, true], [0.1, false]] as const) {
      const sim = pressedAt(script, 3, until + offset, back);
      const attack = sim.frames[3]!;
      expect(attack.world).toBeCloseTo(until + offset, 6);
      expect(attack.enhancedBasic !== null).toBe(enhanced);
    }
  });

  it("another operator's combo outside any pause still slows the window", () => {
    const script = (wait: number) =>
      `team: Laevatain, Chen Qianyu\nLaevatain: ULT\nChen Qianyu: BS\nChen Qianyu: CS\nLaevatain: WAIT ${wait}s\nLaevatain: BA`;
    const probe = run(script(0));
    const [ult] = probe.frames;
    const slowed = timerEnd(probe.dilations, ult!.world, seconds);
    expect(slowed).toBeGreaterThan(ult!.world + seconds + 0.5);
    const back = probe.frames[4]!.world;
    for (const [offset, enhanced] of [[-0.1, true], [0.1, false]] as const) {
      const sim = pressedAt(script, 4, slowed + offset, back);
      const attack = sim.frames[4]!;
      expect(attack.world).toBeCloseTo(slowed + offset, 6);
      expect(attack.enhancedBasic !== null).toBe(enhanced);
    }
  });
});
