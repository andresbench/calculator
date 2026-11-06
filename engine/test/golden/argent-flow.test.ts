/**
 * Golden test: Argent Flow's Bolt Rush, Sunderization and the Crush it sets
 * off.
 *
 * Source — `docs/measurements.md`, #59 (2026-11-05). Argent Flow (E4, P0)
 * with Perlica and the Endministrator on Rhodagn (resistance 0), no crits.
 * Stat screens at the start of the fight: Argent Flow ATK 5348, AI 78,
 * Electric +39.9 %; the Endministrator ATK 5765, AI 108, Physical +74.8 %.
 * Right after Bolt Rush the Endministrator's screen read ATK 6236, AI 153.
 *
 * * One Electric stack before Bolt Rush (his combo's last hit) →
 *   Electrification II and two Sunderization stacks: level = I + consumed.
 * * The Endministrator's SEQ 1: 2569 before, 3482 under his Electrification
 *   — ×(6236 / 5765) for ATK and ×(1 + 0.16 × debuffIntensity(78 + 45)) for
 *   DMG Taken on a Physical hit.
 * * Her battle skill on the marked target: Crush and the explosion 87,292.
 */

import { expect, it } from 'vitest';

import { buildAliases, debuffIntensity, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, type Bundle } from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

/** The game shows whole numbers. */
const TOLERANCE = 1;

describeWithBundle('Argent Flow: Bolt Rush and Sunderization (measurements, #59)', (bundle: Bundle) => {
  const rotation = parseRot(
    'team: Argent Flow, Endministrator, Perlica\nArgent Flow: BS\nArgent Flow: CS\nArgent Flow: BS\nEndministrator: CS\nEndministrator: BS',
    buildAliases(bundle),
  );
  const team = teamOf(bundle, rotation.team, rotation.steps);
  const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
    sp: bundle.sp ?? FALLBACK_SP,
    synergy: bundle.synergy,
  });

  it('Bolt Rush eats one Electric stack and leaves Electrification II and two Sunderization stacks', () => {
    const bolt = frames[2]!;
    expect(bolt.transformed?.into).toBe('Bolt Rush');
    const electrification = bolt.target.debuffs.find((debuff) => debuff.term === 'Electrification' && debuff.source === 'Argent Flow');
    expect(electrification?.level).toBe(2);
    expect(electrification?.allTypes).toBe(true);
    expect(bolt.target.marks).toEqual([expect.objectContaining({ term: 'Sunderization', stacks: 2 })]);
  });

  it('her Crush on the marked target is SL 2, boosted ×1.2, and sets off 2 × 330 %', () => {
    const cast = frames[4]!;
    const crush = cast.status.find((event) => event.term === 'Crush');
    expect(crush).toMatchObject({ consumed: 2, boost: 1.2 });
    const blast = cast.status.find((event) => event.kind === 'markDetonated');
    expect(blast).toMatchObject({ term: 'Sunderization', by: 'Argent Flow', consumed: 2, aiPerPoint: 0.006 });
    expect(blast!.multiplier).toBeCloseTo(6.6, 10);
    expect(cast.target.marks).toEqual([]);
  });

  it('his Electrification raises a Physical hit by its own value, at his AI', () => {
    const before = 5765 * 0.51 * 0.5 * 1.748;
    expect(Math.abs(before - 2569)).toBeLessThanOrEqual(TOLERANCE);
    const dmgTaken = 0.16 * debuffIntensity(78 + 45);
    const under = 6236 * 0.51 * 0.5 * 1.748 * (1 + dmgTaken);
    expect(Math.abs(under - 3482)).toBeLessThanOrEqual(TOLERANCE + 1);
  });
});
