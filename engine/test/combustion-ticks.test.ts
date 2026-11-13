/**
 * Combustion burns from the hit that lit it until the reaction is gone
 * (audit 2026-11-12, В7): not past a skill taking it off the target, and not
 * from the press of a step a hit in flight happened to land in.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  statusHits,
  type SimulateOptions,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('Combustion ticks', (bundle) => {
  const run = (text: string, extra: SimulateOptions = {}) => {
    const rotation = parseRot(text, buildAliases(bundle));
    return simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
      unlimitedSp: true,
      ...extra,
    });
  };
  const ticksOf = (sim: ReturnType<typeof run>) =>
    statusHits(sim.frames, sim.world).flatMap((hits, frame) =>
      hits.filter((hit) => hit.name === 'Combustion DoT').map((hit) => ({ frame, ticks: hit.ticks })),
    );

  it('stops when a skill takes the reaction off the target', () => {
    // Akekuri sets off Perlica's Electric; Wulfgard's battle skill consumes the Combustion 3.5 s later.
    const sim = run('team: Perlica, Akekuri, Wulfgard\nPerlica: BS\nAkekuri: BS\nAkekuri: WAIT 2s\nWulfgard: BS\nWulfgard: WAIT 12s');
    const burn = sim.frames[1]!.target.debuffs.find((debuff) => debuff.term === 'Combustion')!;
    const taker = sim.frames[3]!;
    expect(taker.status.some((event) => event.term === 'Combustion' && event.kind === 'reactionConsumed')).toBe(true);
    expect(taker.target.debuffs.some((debuff) => debuff.term === 'Combustion')).toBe(false);
    // It would have burned past the rotation's end otherwise: 10 s of it.
    expect(sim.world - burn.appliedAt).toBeGreaterThan(10);
    expect(ticksOf(sim)).toEqual([{ frame: 1, ticks: Math.floor(taker.world - burn.appliedAt + 1e-9) }]);
    expect(ticksOf(sim)[0]!.ticks).toBeLessThan(10);
  });

  it('counts from the hit in flight that lit it, not from the press of the step it landed in', () => {
    const sim = run('team: Perlica, Akekuri, Chen Qianyu\nPerlica: BS\nPerlica: WAIT 1s\nAkekuri: BS\nChen Qianyu: BS\nChen Qianyu: WAIT 3.2s');
    const lit = sim.frames.findIndex((frame) => frame.status.some((event) => event.term === 'Combustion' && event.kind === 'consumesInfliction'));
    const burn = sim.frames[lit]!.target.debuffs.find((debuff) => debuff.term === 'Combustion')!;
    // The hit comes well after the press of the step it falls in, and the rotation ends a whole second later.
    expect(burn.appliedAt).toBeGreaterThan(sim.frames[lit]!.world + 0.3);
    expect(Math.floor(sim.world - sim.frames[lit]!.world)).not.toBe(Math.floor(sim.world - burn.appliedAt));
    expect(ticksOf(sim)).toEqual([{ frame: lit, ticks: Math.floor(sim.world - burn.appliedAt + 1e-9) }]);
  });
});
