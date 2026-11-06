/**
 * Golden test: how long a combo and an ultimate hold the track, and what an
 * ultimate's cutscene and a perfect dodge do to SP.
 *
 * Source — `docs/measurements.md`:
 *
 * * #35 — Endministrator, 60 fps video. After her combo another operator's
 *   battle skill starts ~25 client frames in (the client's window: frame 23,
 *   so 24); after her ultimate at 46 (the cutscene ends at 44, so 45). During
 *   the cutscene the stage clock and combo cooldowns run, natural SP regen
 *   stands still (run L5: a battle skill pressed after it waited for a full
 *   gauge).
 * * #40 — perfect dodge: net +3.37 ± 0.05 SP (jump minus the regen lost).
 * * #42 — a dodge keeps the basic chain.
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, type Bundle, type SimulateOptions } from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

const FPS = 30;
/** One client frame: the video resolves 60 fps, the reading ±1 client frame. */
const FRAME = 1 / FPS;

describeWithBundle('skill windows, cutscene and dodge (measurements, #35, #40)', (data: Bundle) => {
  const aliases = buildAliases(data);
  const run = (text: string, extra: SimulateOptions = {}) => {
    const rotation = parseRot(text, aliases);
    const team = teamOf(data, rotation.team, rotation.steps);
    return simulate(rotation.steps, team, data.timings ?? FALLBACK_TIMINGS, {
      sp: data.sp ?? FALLBACK_SP,
      synergy: data.synergy,
      ...extra,
    });
  };

  it("the Endministrator's combo holds the track for its measured window, whatever the scale", () => {
    for (const scale of [0.5, 1, 2]) {
      const sim = run('Chen Qianyu: CS\nEndministrator: CS', { scale });
      expect(Math.abs(sim.frames[1]!.duration - 25 * FRAME)).toBeLessThanOrEqual(FRAME);
    }
  });

  it('her ultimate holds the track until the cutscene ends', () => {
    const sim = run('Endministrator: ULT', { ultimatesCharged: true });
    expect(Math.abs(sim.frames[0]!.duration - 46 * FRAME)).toBeLessThanOrEqual(FRAME);
  });

  it('natural SP regen stands still through the cutscene', () => {
    const regen = data.sp?.passiveRegen ?? 8;
    // The same time on the track, once as the ultimate and once as a plain pause.
    const ultimate = run('Endministrator: BS\nEndministrator: ULT\nEndministrator: WAIT 3s', { ultimatesCharged: true });
    const cutscene = ultimate.frames[1]!.duration;
    const pause = run(`Endministrator: BS\nEndministrator: WAIT ${cutscene}s\nEndministrator: WAIT 3s`, { ultimatesCharged: true });
    const lost = pause.frames[2]!.sp - ultimate.frames[2]!.sp;
    expect(lost).toBeCloseTo(cutscene * regen, 6);
  });

  it("Chen's battle skill holds another operator only as long as the button mashing (#35, 2026-11-05)", () => {
    // Pogranichnik's battle skill started 8 and 13 client frames after hers; the faster is the bound.
    for (const scale of [0.5, 2]) {
      const sim = run('team: Chen Qianyu, Pogranichnik\nChen Qianyu: BS\nPogranichnik: BS', { scale });
      expect(Math.abs(sim.frames[0]!.duration - 8 * FRAME)).toBeLessThanOrEqual(1e-4);
    }
    // Her own next action waits for her window (frame 25 + 1), unmeasured on video.
    const own = run('Chen Qianyu: BS\nChen Qianyu: BA');
    expect(own.frames[0]!.duration).toBeGreaterThan(8 * FRAME);
  });

  it('a perfect dodge nets the measured SP', () => {
    const regen = data.sp?.passiveRegen ?? 8;
    const dodge = data.sp!.perfectDodge!;
    const net = dodge.sp - dodge.regenPause * regen;
    expect(Math.abs(net - 3.37)).toBeLessThanOrEqual(0.05);
  });
});
