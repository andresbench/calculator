/**
 * Golden test: how Corrosion's resistance shred grows and where it caps.
 *
 * Source — `docs/measurements.md`, #39 (2026-11-05). Arcane (E4, so the
 * talent raises the cap by ×1.1; Arts Intensity 30 on the stat screen),
 * Corrosion SL IV on Rhodagn (resistance 0). Chen's single SEQ 1 hits,
 * each made the first of a chain by a short run between them (#42), against
 * her clean references: SEQ 1 second hit 1327, SEQ 2 2370.
 *
 * | when | game | meaning |
 * |---|---|---|
 * | ~12 s after Corrosion | 1730 | step 11: (7.2 + 1.68·11) × k |
 * | plateau | 1741 (SEQ 1), 3109 (SEQ 2) | cap: 24 × k × 1.1 |
 *
 * k = (3·AI + 300)/(AI + 300) = 1.1818 at AI 30: Arts Intensity scales the
 * start, the step and the cap alike. The AI-0 prediction capped at ×1.264.
 */

import { describe, expect, it } from 'vitest';

import { corrosionShred } from '../../src/statusHits.js';

/** The game shows whole numbers. */
const TOLERANCE = 1;
const SL = 4;
const AI = 30;
/** Arcane's talent at E4: the cap ×1.1. */
const CAP_BONUS = 0.1;

const hit = (reference: number, shred: number) => reference * (1 + shred);

describe('Corrosion shred (measurements, #39)', () => {
  it('step 11 matches the hit at ~12 s', () => {
    const shred = corrosionShred(SL, AI, 11, CAP_BONUS);
    expect(Math.abs(hit(1327, shred) - 1730)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('the cap matches the plateau for two different hits', () => {
    const cap = corrosionShred(SL, AI, 60, CAP_BONUS);
    expect(Math.abs(hit(1327, cap) - 1741)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(hit(2370, cap) - 3109)).toBeLessThanOrEqual(TOLERANCE);
  });
});
