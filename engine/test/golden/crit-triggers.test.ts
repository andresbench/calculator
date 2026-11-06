/**
 * Golden test: crit-triggered stacks come per critting hit, a status's
 * instant hit included.
 *
 * Source — `docs/measurements.md`, #57 (2026-11-05). Endministrator with
 * `Lupine Scarlet` and three `MI Security` pieces on Rhodagn: one critting
 * basic hit gave +1 to Wolven Blood and to MI Security; a battle skill whose
 * own hit (21,980) and Crush (12,689) both critted gave +2 to each at once.
 *
 * The track works with expectations: a hit adds the crit rate, a stack comes
 * when the running sum crosses a whole number. With the rate forced to 1 it
 * must reproduce the measured counts exactly.
 */

import { expect, it } from 'vitest';

import {
  activeEffects,
  buildAliases,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  trackBuffs,
  type Bundle,
} from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

describeWithBundle('crit-triggered stacks (measurements, #57)', (bundle: Bundle) => {
  const rotation = parseRot('Endministrator: BA\nEndministrator: BS\nEndministrator: WAIT 1s', buildAliases(bundle));
  const team = teamOf(bundle, rotation.team, rotation.steps);
  const key = [...team.keys()][0]!;
  const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
    sp: bundle.sp ?? FALLBACK_SP,
    synergy: bundle.synergy,
  });
  const active = activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0, sets: { 'MI Security': 3 } });
  /** Measured: one critting basic hit, then a cast with two critting hits (own hit and Crush). */
  const hits = [1, 2, 0];
  const stacks = (rate: number) => {
    const timeline = trackBuffs(frames, [{ key, active, critRate: rate }], (index, holder) => (holder === key ? hits[index]! : 0));
    return timeline.frames.map((standing) =>
      Math.max(0, ...standing.filter((buff) => buff.effect.item === 'MI Security' && buff.apply.stat === 'atk_pct').map((buff) => buff.stacks)),
    );
  };

  it('every critting hit is a stack, the status hit too', () => {
    // A step's stacks count from the next step: 0 → 1 after the basic hit → 3 after the battle skill.
    expect(stacks(1)).toEqual([0, 1, 3]);
  });

  it('at a lower rate the stacks follow the expectation', () => {
    // 0.5 per hit: 0.5 after the basic hit, 1.5 after the cast — one stack, from the cast on.
    expect(stacks(0.5)).toEqual([0, 0, 1]);
  });
});
