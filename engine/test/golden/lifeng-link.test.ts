/**
 * Golden test: how long Lifeng's Link lasts.
 *
 * Source — `docs/measurements.md`, #41 (2026-11-05). Lifeng's combo, then
 * nothing pressed: the team's Link icon goes away on its own after 20 s —
 * the combo's `Combo Duration (s)` row.
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, type Bundle } from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

describeWithBundle("Lifeng's Link lasts 20 s (measurements, #41)", (bundle: Bundle) => {
  const play = (wait: number) => {
    const rotation = parseRot(`team: Lifeng\nLifeng: CS\nLifeng: WAIT ${wait}s\nLifeng: BS`, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    return simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, { sp: bundle.sp ?? FALLBACK_SP, synergy: bundle.synergy }).frames;
  };

  it('the combo leaves a Link that expires 20 s later', () => {
    const [combo] = play(1);
    const link = combo!.links.find((item) => item.term === 'Link');
    expect(link!.expiresAt! - link!.appliedAt).toBeCloseTo(20, 10);
  });

  it('a battle skill inside the 20 s spends it', () => expect(play(15)[2]!.link).toMatchObject({ count: 1 }));
  it('a battle skill after the 20 s finds none', () => expect(play(21)[2]!.link).toBeNull());
});
