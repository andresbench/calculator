/**
 * A hit in flight comes down in a pause and after the last press, not only
 * inside a cast (audit 2026-11-12, В6): the battle skill's statuses and a
 * Lifeng's ultimate's second slam were lost, or put on the wrong frame.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  type Frame,
  type SimulateOptions,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('hits in flight: pauses and the end of the rotation', (bundle) => {
  const run = (text: string, extra: SimulateOptions = {}) => {
    const rotation = parseRot(text, buildAliases(bundle));
    return simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
      unlimitedSp: true,
      ...extra,
    });
  };
  const lands = (key: string): number => bundle.sp!.basicAttack![key]!.skillWindows!.BS!.lands!;
  const taken = (frame: Frame, term: string) => frame.status.filter((event) => event.term === term && event.kind === 'consumesInfliction');

  // Perlica's Electric stands on the target; Akekuri's battle skill is a Heat hit that lands 0.67 s
  // after her press and sets it off (Combustion), while the next press is already waiting.
  const base = 'team: Perlica, Akekuri, Wulfgard\nPerlica: BS\nAkekuri: BS\n';

  it("a rotation ending in another operator's pause still has the hit that was coming", () => {
    const { frames } = run(`${base}Wulfgard: WAIT 5s`);
    const [, akekuri, pause] = frames;
    expect(taken(pause!, 'Combustion')).toHaveLength(1);
    const at = akekuri!.world + lands('Akekuri');
    expect(taken(pause!, 'Combustion')[0]!.at).toBeCloseTo(at, 9);
    expect(pause!.target.debuffs.find((debuff) => debuff.term === 'Combustion')?.appliedAt).toBeCloseTo(at, 9);
    expect(pause!.target.inflictions.Electric).toBe(0);
  });

  it('inside the rotation the hit lands on the pause it falls in, not on the cast after it', () => {
    const { frames } = run(`${base}Wulfgard: WAIT 2s\nWulfgard: BS`);
    const [, , pause, cast] = frames;
    expect(taken(pause!, 'Combustion')).toHaveLength(1);
    expect(taken(cast!, 'Combustion')).toHaveLength(0);
    expect(cast!.verdicts.has(`${cast!.step.index}:landsHere:Akekuri`)).toBe(false);
    expect(pause!.verdicts.get(`${pause!.step.index}:landsHere:Akekuri`)).toMatchObject({ code: 'landsHere', operator: 'Akekuri' });
  });

  it("Lifeng's second slam, past the end of the last press, is delivered on the last frame", () => {
    const slams = bundle.sp!.basicAttack!.Lifeng!.skillHits!.ULT!.filter((hit) => hit.status);
    expect(slams.length).toBeGreaterThanOrEqual(2);
    const { frames, world } = run('team: Lifeng, Chen Qianyu\nLifeng: ULT\nChen Qianyu: BS', { ultimatesCharged: true });
    const knocks = frames[1]!.status.filter((event) => event.term === 'Knock Down' && event.by === 'Lifeng');
    expect(knocks.map((event) => event.at)).toEqual(slams.slice(0, 2).map((hit) => expect.closeTo(frames[0]!.world + hit.at, 9)));
    // It comes after the rotation's end, and does not move it.
    expect(knocks[1]!.at!).toBeGreaterThan(world);
  });
});
