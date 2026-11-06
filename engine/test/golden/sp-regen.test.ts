/**
 * Golden test: passive SP regeneration.
 *
 * Source — `docs/measurements.md`, #20 (2026-11-04). Chen Qianyu alone,
 * three battle skills in a row, then nothing until the gauge refills;
 * 60 fps video, two cycles. Each 100-SP segment of the gauge filled in
 * 751 ± 4 recorded frames (749 · 754 · 749 · 754 between segment starts,
 * 754 · 747 between segment ends, in both cycles). The wiki's 8 SP/s
 * predicts 750, a community table's 7.69 predicts 780.
 */

import { expect, it } from 'vitest';

import { describeWithBundle } from '../support/bundle.js';

const RECORDED_FPS = 60;
const FRAMES_PER_BAR = 751;
/** Spread of the six intervals around their mean. */
const TOLERANCE_FRAMES = 4;

describeWithBundle('passive SP regen (measurements, #20)', (bundle) => {
  it('one bar of 100 SP takes the measured time', () => {
    const regen = bundle.sp?.passiveRegen;
    expect(regen).toBeDefined();
    const frames = (100 / regen!) * RECORDED_FPS;
    expect(Math.abs(frames - FRAMES_PER_BAR)).toBeLessThanOrEqual(TOLERANCE_FRAMES);
  });
});
