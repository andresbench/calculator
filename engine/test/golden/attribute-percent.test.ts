/**
 * Golden test: a percent attribute on gear is computed from the full
 * attribute.
 *
 * Source — `docs/measurements.md`, #28, closed 2026-10-17 as `confirmed`.
 * Arcane wears `LYNX Slab` ("Main Attribute +26.9 %", the main attribute
 * being Intellect). The number was predicted before the screen was taken:
 *
 * | hypothesis                                      | Intellect |
 * |-------------------------------------------------|-----------|
 * | of the full sum (curve + gear + weapon + talents) | 782.3   |
 * | of curve and gear                               | 735.2     |
 * | of the curve only                               | 663.9     |
 * | the percent does nothing                        | 616.4     |
 *
 * The screen showed **782**. Control in the same frame — Will 362: it has
 * no percentages, and it confirms the gear is at max tier (the showcase
 * does not report the tier, and the prediction relied on it).
 *
 * The build is written out here; item, weapon and talent numbers come from
 * the bundle and the effects layer.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assertBundle, buildStatsWithEffects, type Bundle, type BuildInput } from '../../src/index.js';
import { bundle, describeWithBundle } from '../support/bundle.js';

/** From the stat screen, 2026-10-17. The screen rounds to an integer. */
const SCREEN = { INT: 782, WIL: 362 } as const;


describeWithBundle('percent attribute on gear — Arcane, LYNX Slab (measurements, #28)', () => {
  // The build from the 2026-10-17 screen, not from the roster: the showcase
  // is a snapshot, and by 2026-10-29 Arcane was already in Eternal Xiranite.
  // `Junction Point` with essence 5 / 5 / 3: stats in column 8, the named
  // effect in column 4 (#6).
  const GEAR = ['Hot Work Hands PPE', 'Hot Work Exo-Rig', 'Hot Work Insulation Slab', 'LYNX Slab'];
  const COLUMNS = { 'Intellect [L]': 8, 'ULT Efficiency [L]': 8, 'Efficacy: Feedback Loop': 4 };

  function arcane() {
    const gear: BuildInput['gear'] = GEAR.map((name) => {
      const piece = bundle!.gear.pieces[name]!;
      return { piece, tier: piece.stats[0]!.values.length - 1 };
    });
    return buildStatsWithEffects(
      {
        operator: bundle!.operators['Arcane']!,
        level: 90,
        weapon: { weapon: bundle!.weapons['Junction Point']!, level: 90, columns: COLUMNS },
        gear,
      },
      bundle!.effects,
      { operator: 'Arcane', elite: 4, potential: 0 },
    ).sheet;
  }

  it('Intellect matches the screen: a percent of the full attribute', () => {
    expect(Math.abs(arcane().attributes.INT - SCREEN.INT)).toBeLessThanOrEqual(0.5);
  });

  it('control: Will, with no percentages, matches too — gear at max tier', () => {
    expect(Math.abs(arcane().attributes.WIL - SCREEN.WIL)).toBeLessThanOrEqual(0.5);
  });
});
