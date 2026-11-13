/**
 * A cast that waited (for SP, for a cooldown) goes by the meter as it stands
 * after the wait, not before it (audit 2026-11-12, В4 — А1 for the stagger).
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('stagger after a wait', (bundle) => {
  it('a battle skill that waited for SP is not under a stagger that ended meanwhile', () => {
    const rotation = parseRot('team: Chen Qianyu\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: BS', buildAliases(bundle));
    const members = teamOf(bundle, rotation.team, rotation.steps);
    const target = { name: 'dummy', staggerMeter: 20, staggerRecovery: 5, finisherMultiplier: 1, finisherSp: 0 };
    const { frames } = simulate(rotation.steps, members, bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
      target,
    });
    const last = frames[3]!;
    expect(last.world).toBeGreaterThan(frames[2]!.target.staggeredUntil);
    expect(last.staggeredAtStart).toBe(false);
  });
});
