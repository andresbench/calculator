/**
 * A timer set while a combo's slowdown runs ends where the slowdown puts it
 * (audit 2026-11-12, В9). `retime` and `cutSlowdown` read the stagger window
 * and the two-phase ultimate's window as timers; set as `world + seconds`,
 * a slowdown that was cut afterwards gave back time it had never taken.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  timerEnd,
  type SimulateOptions,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('timer ends under a combo slowdown', (bundle) => {
  const run = (text: string, extra: SimulateOptions = {}) => {
    const rotation = parseRot(text, buildAliases(bundle));
    return simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
      ...extra,
    });
  };
  const target = { name: 'dummy', staggerMeter: 15, staggerRecovery: 5, finisherMultiplier: 1, finisherSp: 0 };

  it("a stagger that starts inside Chen's slowdown lasts its recovery in timer time", () => {
    const sim = run('team: Chen Qianyu\nChen Qianyu: BS\nChen Qianyu: CS', { target });
    const frame = sim.frames[1]!;
    expect(frame.target.staggered).toBe(true);
    expect(sim.dilations).toHaveLength(1);
    // 0.633 s at ×0.05, then the rest at full speed.
    expect(frame.target.staggeredUntil).toBeCloseTo(timerEnd(sim.dilations, frame.world, target.staggerRecovery), 9);
    expect(frame.target.staggeredUntil).toBeGreaterThan(frame.world + target.staggerRecovery + 0.5);
  });

  it('and a slowdown cut short afterwards takes back only what it had taken', () => {
    const sim = run('team: Chen Qianyu, Lifeng\nChen Qianyu: BS\nChen Qianyu: CS\nLifeng: ULT', { target, ultimatesCharged: true });
    const [, cs, ult] = sim.frames;
    // The ultimate cuts the slowdown 30 ms before its end (`thaw`), and the timer is read through the cut one.
    expect(sim.dilations[0]!.until).toBeLessThan(cs!.world + 0.633 - 0.02);
    expect(ult!.target.staggeredUntil).toBeCloseTo(timerEnd(sim.dilations, cs!.world, target.staggerRecovery), 9);
  });

  it("the second phase of an ultimate pressed 20 ms before its window's end is still the second phase", () => {
    const window = bundle.operators.Arcane!.skills.find((skill) => skill.type === 'Ultimate')!.switch!.window!;
    const script = (wait: number) =>
      `team: Arcane, Chen Qianyu\nChen Qianyu: BS\nChen Qianyu: CS\nArcane: ULT\nArcane: WAIT ${wait}s\nArcane: ULT`;
    const probe = run(script(0), { ultimatesCharged: true }).frames;
    // The first press is thawed to the slowdown's end, so the slowdown is still running when the window is set.
    const first = probe[2]!.world;
    const gap = probe[4]!.world - first;
    const frames = run(script(window - 0.02 - gap), { ultimatesCharged: true }).frames;
    expect(frames[4]!.world - first).toBeCloseTo(window - 0.02, 6);
    expect(frames[4]!.verdicts.get(`${frames[4]!.step.index}:phase`)).toMatchObject({ code: 'secondPhase' });
  });
});
