/**
 * Stat curves of operators and weapons.
 *
 * KEY FINDING (2026-09-12, checked against the data)
 * --------------------------------------------------
 * The wiki gives a stat at six points, each labelled with an
 * "elite + level" pair: base, E1/20, E2/40, E3/60, E4/80, E4/90. Such
 * labels suggest that promotion bumps the stat, as in most games of the
 * genre.
 *
 * It does not. The stat is a **pure linear function of level**; promotion
 * adds nothing by itself and only acts as the level cap.
 *
 * Check: across 125 curves with fractional values (no rounding loss there)
 * the slope of all five adjacent segments agrees to 0.01 %. Example,
 * Akekuri AGL:
 *
 *     15.154 → 42.005 → 70.269 → 98.534 → 126.798 → 140.93
 *     slopes:  1.41321  1.4132  1.41325  1.4132   1.4132
 *
 * If promotion added a bump, the first segment (19 levels plus one
 * promotion) would be noticeably steeper than the last (10 levels, no
 * promotion). There is no difference.
 *
 * CAREFUL: this does not mean elite level is irrelevant. It does not move
 * the base curve, but it unlocks talent tiers, and those grant flat stats
 * ("Operator Agility +10" at Elite 1, another +15 at Elite 2 and so on).
 * So a level-60 operator at E3 and at a freshly promoted E4 do differ — but
 * the talents make the difference, not this function. That is why the
 * roster's `elite_uncertain` flag matters and must not be dropped.
 */

import type { AttributeKey, Breakpoint, Operator, Weapon } from './bundle.js';

/** A curve point: a level and the value at it. */
export interface CurvePoint {
  level: number;
  value: number;
}

/**
 * Unfolds `{base: 30, elite1_lv20: 92, …}` into points by level.
 *
 * The order comes from the bundle's own `breakpoints` rather than being
 * hard-coded here: if the wiki ever adds a seventh point (level 100 with a
 * new promotion), the export changes, not the engine.
 */
export function toPoints(
  curve: Record<string, number> | undefined,
  breakpoints: Breakpoint[],
): CurvePoint[] {
  if (!curve) return [];
  const points: CurvePoint[] = [];
  for (const breakpoint of breakpoints) {
    const value = curve[breakpoint.key];
    if (typeof value === 'number') {
      points.push({ level: breakpoint.level, value });
    }
  }
  return points.sort((a, b) => a.level - b.level);
}

/**
 * A stat's value at an arbitrary level.
 *
 * Inside the range — linear interpolation, which is not an assumption but
 * a reproduction of the curve (see the file header). Outside — the nearest
 * known point, no extrapolation: there is no level above 90 in the game,
 * and this project does not invent values beyond the data.
 */
export function valueAtLevel(points: CurvePoint[], level: number): number | null {
  if (points.length === 0) return null;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  if (level <= first.level) return first.value;
  if (level >= last.level) return last.value;

  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (level >= a.level && level <= b.level) {
      const span = b.level - a.level;
      if (span === 0) return a.value;
      return a.value + ((b.value - a.value) * (level - a.level)) / span;
    }
  }
  return last.value;
}

/** An operator's attribute at the given level. */
export function operatorAttribute(
  operator: Operator,
  attribute: AttributeKey,
  level: number,
): number | null {
  const points = toPoints(operator.attributes[attribute], operator.breakpoints);
  return valueAtLevel(points, level);
}

/** A weapon's base attack at the given level. */
export function weaponAttack(weapon: Weapon, level: number): number | null {
  const points = toPoints(weapon.baseAttack, weapon.breakpoints);
  return valueAtLevel(points, level);
}

/**
 * Level cap for each promotion tier.
 *
 * Not needed for stats (they do not depend on promotion), but so the UI can
 * limit input and so the minimum elite level can be inferred from a level —
 * for instance when a screenshot shows only the level.
 */
export const ELITE_LEVEL_CAP: Record<number, number> = { 0: 10, 1: 20, 2: 40, 3: 60, 4: 90 };

/** The lowest elite level at which this level is reachable. */
export function minimumElite(level: number): number {
  const tiers = Object.keys(ELITE_LEVEL_CAP)
    .map(Number)
    .sort((a, b) => a - b);
  for (const tier of tiers) {
    if (level <= ELITE_LEVEL_CAP[tier]!) return tier;
  }
  return tiers[tiers.length - 1]!;
}
