/**
 * The energy bar holds the ultimate's cost, not a flat 200: Last Rite's
 * ultimate costs 240, and under a 200 cap it never charged again (audit
 * 2026-11-12, В2).
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, ultimateCost } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('energy cap', (bundle) => {
  it("Last Rite charges to her ultimate's cost, above 200", () => {
    const lines = ['team: Last Rite, Akekuri'];
    for (let index = 0; index < 40; index += 1) lines.push('Akekuri: BS', 'Last Rite: CS');
    lines.push('Last Rite: ULT');
    const rotation = parseRot(lines.join('\n'), buildAliases(bundle));
    const members = teamOf(bundle, rotation.team, rotation.steps);
    const cost = ultimateCost(members.get('Last Rite')!);
    expect(cost).toBeGreaterThan(200);
    const { frames } = simulate(rotation.steps, members, bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
      unlimitedSp: true,
    });
    expect(frames.at(-2)!.energy['Last Rite']).toBe(cost);
    expect([...frames.at(-1)!.verdicts.values()].map((verdict) => verdict.code)).not.toContain('ultimateNotCharged');
  });
});
