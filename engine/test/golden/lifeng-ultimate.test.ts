/**
 * Golden test: Lifeng's ultimate knocks down twice, on two slams.
 *
 * Source — `docs/measurements.md`, #73, Teo's 60 fps video «Howling
 * beasts.mp4». Every time is a recording frame from the first frame of the
 * cutscene (2150); a mark is good to a frame on either side, so two marks
 * give ±2 frames of 60.
 *
 * * The interface is back at 2264: +114 = the client's 57-frame cutscene,
 *   so the start is found right.
 * * The first slam's numbers at 2278: +128, 2.133 s.
 * * Chen's combo pressed after it; the second slam's numbers, «Knocked
 *   Down», at 2436: +286, 4.767 s — Chen's 0.633 s slowdown at ×0.05 inside.
 * * Two Vulnerable stacks from the ultimate, one per slam (Teo).
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, type Bundle } from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

/** Two marks on a 60 fps recording. */
const MARKS = 2 / 60;
const FIRST = (2278 - 2150) / 60;
const SECOND = (2436 - 2150) / 60;

describeWithBundle("Lifeng's ultimate: two slams, two Knock Downs (measurements, #73)", (data: Bundle) => {
  const aliases = buildAliases(data);
  const run = (text: string) => {
    const rotation = parseRot(text, aliases);
    const team = teamOf(data, rotation.team, rotation.steps);
    return simulate(rotation.steps, team, data.timings ?? FALLBACK_TIMINGS, {
      sp: data.sp ?? FALLBACK_SP,
      synergy: data.synergy,
      ultimatesCharged: true,
    });
  };
  const knockDowns = (sim: ReturnType<typeof run>) =>
    sim.frames.flatMap((frame) => frame.status.filter((event) => event.term === 'Knock Down' && event.by === 'Lifeng'));

  it('the cutscene is the client’s: the interface comes back at +114 frames', () => {
    const ult = data.sp!.basicAttack!.Lifeng!.skillWindows!.ULT!;
    expect(Math.abs(ult.cutscene! - (2264 - 2150) / 60)).toBeLessThanOrEqual(MARKS);
  });

  it('as in the video: the first slam at 2.133 s, the second at 4.767 s with Chen’s combo between', () => {
    const sim = run('team: Lifeng, Chen Qianyu\nLifeng: ULT\nChen Qianyu: CS\nChen Qianyu: BA');
    const [first, second] = knockDowns(sim);
    expect(Math.abs(first!.at! - FIRST)).toBeLessThanOrEqual(MARKS);
    expect(Math.abs(second!.at! - SECOND)).toBeLessThanOrEqual(MARKS);
    // Chen's combo waited for the first stack and opened on it.
    expect(sim.frames[1]!.world).toBeCloseTo(first!.at!, 6);
  });

  it('two Vulnerable stacks, one per slam', () => {
    const sim = run('team: Lifeng, Endministrator\nLifeng: ULT\nEndministrator: BA');
    expect(knockDowns(sim)).toHaveLength(2);
    expect(sim.frames[1]!.target.vulnerable).toBe(2);
  });
});
