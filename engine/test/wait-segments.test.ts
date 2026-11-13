/**
 * A wait for SP stops where a hit in flight lands and reads the shortfall
 * again (audit 2026-11-12, В5). Pogranichnik's Breach eats two Vulnerable
 * 1.4 s after his press and recovers 15 SP; a Chen battle skill that waits
 * for SP meanwhile used to wait as if it were not coming, and the 15 SP
 * arrived at the end of the wait, after she had already paid.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  statAt,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('a wait for SP and a hit that lands in it', (bundle) => {
  const rotation = parseRot(
    'team: Chen Qianyu, Pogranichnik\nChen Qianyu: BS\nChen Qianyu: BS\nPogranichnik: BS\nChen Qianyu: BS',
    buildAliases(bundle),
  );
  const sim = simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), bundle.timings ?? FALLBACK_TIMINGS, {
    synergy: bundle.synergy,
    sp: bundle.sp ?? FALLBACK_SP,
  });
  const [, , pogranichnik, chen] = sim.frames;
  const lands = bundle.sp!.basicAttack!.Pogranichnik!.skillWindows!.BS!.lands!;
  const landing = pogranichnik!.world + lands;
  const cost = statAt(bundle.operators['Chen Qianyu']!.skills.find((skill) => skill.type === 'Battle Skill')!, 'SP Cost', 12)!;

  it('the SP lands when the hit does, and what the cast pays is what the wait waited for', () => {
    expect(chen!.spRecoveredBy.Pogranichnik).toBeGreaterThan(0);
    const recovered = chen!.spRecoveredBy.Pogranichnik!;
    // The hit comes inside the wait: after it began, before the cast.
    const [waited] = sim.waits;
    expect(sim.waits).toHaveLength(1);
    const start = chen!.world - waited!.seconds;
    expect(landing).toBeGreaterThan(start);
    expect(landing).toBeLessThan(chen!.world);
    // The recovery is a step in the SP track at the hit's own time.
    const at = sim.spTimeline.filter((point) => Math.abs(point.t - landing) < 1e-6);
    expect(at.length).toBeGreaterThanOrEqual(2);
    expect(at.at(-1)!.sp - at[0]!.sp).toBeCloseTo(recovered, 6);
    // The wait is what is short of the cost after the recovery, at the regen.
    const spStart = pogranichnik!.sp + sim.regen * (start - pogranichnik!.world);
    expect(waited!.seconds).toBeCloseTo((cost - recovered - spStart) / sim.regen, 6);
    // Nothing is left over when the cast pays.
    expect(chen!.sp).toBeCloseTo(0, 6);
  });
});
