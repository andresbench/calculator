import { describe, expect, it } from 'vitest';

import {
  ELITE_LEVEL_CAP,
  minimumElite,
  toPoints,
  valueAtLevel,
  type Breakpoint,
} from '../src/index.js';

const BREAKPOINTS: Breakpoint[] = [
  { key: 'base', elite: 0, level: 1 },
  { key: 'elite1_lv20', elite: 1, level: 20 },
  { key: 'elite2_lv40', elite: 2, level: 40 },
  { key: 'elite3_lv60', elite: 3, level: 60 },
  { key: 'elite4_lv80', elite: 4, level: 80 },
  { key: 'elite4_lv90', elite: 4, level: 90 },
];

// The real Agility curve of Akekuri from data/endfield/operators.json.
// Chosen because its values are fractional: on integer curves the wiki's
// rounding masks deviations from a straight line.
const AKEKURI_AGL = {
  base: 15.154,
  elite1_lv20: 42.005,
  elite2_lv40: 70.269,
  elite3_lv60: 98.534,
  elite4_lv80: 126.798,
  elite4_lv90: 140.93,
};

describe('stat curves', () => {
  it('unfolds named points into levels in order', () => {
    const points = toPoints(AKEKURI_AGL, BREAKPOINTS);
    expect(points.map((p) => p.level)).toEqual([1, 20, 40, 60, 80, 90]);
    expect(points[0]!.value).toBe(15.154);
  });

  it('skips points missing from the data', () => {
    const points = toPoints({ base: 10, elite4_lv90: 100 }, BREAKPOINTS);
    expect(points).toHaveLength(2);
  });

  it('returns the exact value at the nodes', () => {
    const points = toPoints(AKEKURI_AGL, BREAKPOINTS);
    for (const breakpoint of BREAKPOINTS) {
      const expected = AKEKURI_AGL[breakpoint.key as keyof typeof AKEKURI_AGL];
      expect(valueAtLevel(points, breakpoint.level)).toBeCloseTo(expected, 6);
    }
  });

  // The central claim of this file: the curve is a straight line in level,
  // and promotion adds nothing to the stat. Checked on 125 fractional
  // curves; pinned here as a test so the finding is not lost.
  it('the curve is linear in level: promotion adds no bump', () => {
    const points = toPoints(AKEKURI_AGL, BREAKPOINTS);
    const slopes: number[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i]!;
      const b = points[i + 1]!;
      slopes.push((b.value - a.value) / (b.level - a.level));
    }
    const min = Math.min(...slopes);
    const max = Math.max(...slopes);
    expect((max - min) / max).toBeLessThan(0.001);
  });

  it('interpolates between nodes along the same line', () => {
    const points = toPoints(AKEKURI_AGL, BREAKPOINTS);
    // Level 70 lies exactly between 60 and 80.
    const at70 = valueAtLevel(points, 70)!;
    expect(at70).toBeCloseTo((98.534 + 126.798) / 2, 6);
    // And it lies on the line through the first and last points.
    const slope = (140.93 - 15.154) / (90 - 1);
    expect(at70).toBeCloseTo(15.154 + slope * (70 - 1), 1);
  });

  it('does not extrapolate past the ends but holds the edge value', () => {
    const points = toPoints(AKEKURI_AGL, BREAKPOINTS);
    expect(valueAtLevel(points, 0)).toBe(15.154);
    expect(valueAtLevel(points, 999)).toBe(140.93);
  });

  it('returns null, not zero, on an empty curve', () => {
    expect(valueAtLevel([], 50)).toBeNull();
  });
});

describe('elite level', () => {
  it('infers the minimum elite from the level', () => {
    expect(minimumElite(20)).toBe(1);
    expect(minimumElite(40)).toBe(2);
    expect(minimumElite(90)).toBe(4);
  });

  it('level 90 is reachable only at the fourth elite', () => {
    expect(ELITE_LEVEL_CAP[3]).toBeLessThan(90);
    expect(minimumElite(61)).toBe(4);
  });
});
