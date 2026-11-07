/**
 * Perlica's P1 — «Combo skill Instant Protocol: Chain improved:
 * Electrification duration +75%» — the same reaction edit as Laevatain's P3
 * (`reaction_duration_mult`). Until 2026-11-07 it was listed as «the engine
 * does not type reactions», which the vocabulary had long stopped being.
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simModifiersFor, simulate, type Bundle } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle("Perlica's P1: her combo's Electrification lasts ×1.75", (bundle: Bundle) => {
  const electrification = (potential: number) => {
    const rotation = parseRot('Perlica: CS', buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const sim = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      sp: bundle.sp ?? FALLBACK_SP,
      synergy: bundle.synergy,
      modifiers: simModifiersFor(bundle, team, () => potential),
    });
    const frame = sim.frames[0]!;
    const debuff = frame.target.debuffs.find((item) => item.term === 'Electrification')!;
    return debuff.expiresAt! - frame.world;
  };

  it('the forced Electrification is longer by 75 % with the potential', () => {
    // Her combo's own slowdown stretches the timer by the same amount either
    // way (measurements, #70): take it out, then the durations compare.
    const dilation = bundle.sp!.basicAttack!.Perlica!.skillWindows!.CS!.dilation ?? 0;
    const stretch = dilation * (1 - (bundle.timings!.comboTimeScale ?? 0));
    expect((electrification(1) - stretch) / (electrification(0) - stretch)).toBeCloseTo(1.75, 6);
  });
});
