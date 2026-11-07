/**
 * Golden test: when a background battle skill's effects land.
 *
 * Source — `docs/measurements.md`, #63 (2026-11-06). The Endministrator
 * controlled, Lifeng's battle skill pressed, the Endministrator keeps
 * swinging. SP is spent at 6.000 s of the recording, the Stagger gauge
 * jumps by Knock Down's 10 at 8.050 s, and Chen's combo lights up with it:
 * 2.05 s, within ±0.07 s (a recording frame on each side and the UI's one
 * client frame of lag, #35). The client puts Knock Down on frame 54, after
 * two 0.1 s hit stops: 54/30 + 0.2 = 2.00 s.
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, type Bundle } from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

const MEASURED = 2.05;
const TOLERANCE = 0.07;

describeWithBundle("A background battle skill lands with its hit (measurements, #63)", (bundle: Bundle) => {
  const play = (text: string) => {
    const rotation = parseRot(`team: Lifeng, Chen Qianyu, Endministrator\n${text}`, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    return simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, { sp: bundle.sp ?? FALLBACK_SP, synergy: bundle.synergy }).frames;
  };

  it("the client's landing frame matches the recording", () => {
    const lands = bundle.sp?.basicAttack?.['Lifeng']?.skillWindows?.BS?.lands;
    expect(Math.abs(lands! - MEASURED)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('another operator acting after it: nothing lands at the cast', () => {
    const [cast] = play('Lifeng: BS\nEndministrator: BA');
    expect(cast!.applied).toEqual([]);
    expect(cast!.target.debuffs).toEqual([]);
  });

  it("the hit lands inside the Endministrator's chain, and Chen's combo is ready from it", () => {
    const [, chain] = play('Lifeng: BS\nEndministrator: BA');
    expect(chain!.applied).toContainEqual({ term: 'Knock Down', by: 'Lifeng' });
    const chen = chain!.combos.find((combo) => combo.key === 'Chen Qianyu');
    expect(Math.abs(chen!.at - MEASURED)).toBeLessThanOrEqual(TOLERANCE);
    const susceptibility = chain!.target.debuffs.find((debuff) => debuff.term === 'Physical Susceptibility');
    expect(Math.abs(susceptibility!.appliedAt - MEASURED)).toBeLessThanOrEqual(TOLERANCE);
  });

  it("Chen's combo waits for the Knock Down and opens on it", () => {
    const [, combo] = play('Lifeng: BS\nChen Qianyu: CS');
    expect(Math.abs(combo!.world - MEASURED)).toBeLessThanOrEqual(TOLERANCE);
    expect(combo!.problems).toEqual([]);
    expect(combo!.applied).toContainEqual({ term: 'Knock Down', by: 'Lifeng' });
    const susceptibility = combo!.target.debuffs.find((debuff) => debuff.term === 'Physical Susceptibility');
    expect(Math.abs(susceptibility!.appliedAt - MEASURED)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('his own next action: the statuses land with the cast, as before', () => {
    const [cast] = play('Lifeng: BS\nLifeng: BA');
    expect(cast!.applied).toContainEqual({ term: 'Knock Down', by: 'Lifeng' });
  });
});
