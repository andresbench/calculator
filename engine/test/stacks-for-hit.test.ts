/**
 * `Frame.stacksForHit` is what the cast itself ate. Another operator's hit
 * in flight landing inside the step eats for its own caster (audit
 * 2026-11-12, В3): Pogranichnik's Breach consumed 2 Vulnerable inside
 * Yvonne's battle skill, which ate its own 2 Heat — 4 stacks were counted.
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('stacks for hit', (bundle) => {
  it("counts only the cast's own consumption", () => {
    const script = [
      'team: Chen Qianyu, Pogranichnik, Yvonne, Akekuri',
      'Chen Qianyu: BS',
      'Chen Qianyu: BS',
      'Akekuri: BS',
      'Akekuri: BS',
      'Pogranichnik: BS',
      'Yvonne: BS',
      'Yvonne: BA',
    ].join('\n');
    const rotation = parseRot(script, buildAliases(bundle));
    const members = teamOf(bundle, rotation.team, rotation.steps);
    const { frames } = simulate(rotation.steps, members, bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
      unlimitedSp: true,
    });
    const yvonne = frames[5]!;
    const own = yvonne.status.filter((event) => event.kind === 'consumesInfliction' && event.by === 'Yvonne');
    const foreign = yvonne.status.filter((event) => event.kind === 'consumesVulnerable' && event.by === 'Pogranichnik');
    expect(own.length).toBeGreaterThan(0);
    expect(foreign.length).toBeGreaterThan(0);
    expect(yvonne.stacksForHit).toBe(own.reduce((sum, event) => sum + (event.consumed ?? 0), 0));
  });
});
