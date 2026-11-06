/**
 * An effect that performs a hit (`extra_hit`): Swordmancer's 3-piece —
 * «After the wearer applies a Physical Status, the wearer also performs 1 hit
 * that deals 250% ATK of Physical DMG … Effect trigger cooldown: 15s.»
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
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('extra hits from effects', (bundle: Bundle) => {
  const play = (text: string) => {
    const rotation = parseRot(text, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const key = [...team.keys()][0]!;
    const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      sp: bundle.sp ?? FALLBACK_SP,
      synergy: bundle.synergy,
    });
    const active = activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0, sets: { Swordmancer: 3 } });
    return { frames, timeline: trackBuffs(frames, [{ key, active }]) };
  };

  it('Swordmancer hits on a Physical Status, at most once per 15 s', () => {
    // Chen's battle skill applies Lift. On a clean target the first one is
    // Vulnerable instead, and no hit follows (measurements, #60); the second
    // is a Lift and hits; the third comes inside the cooldown, the fourth after it.
    const { timeline } = play(
      'Chen Qianyu: BS\nChen Qianyu: WAIT 5s\nChen Qianyu: BS\nChen Qianyu: WAIT 5s\nChen Qianyu: BS\nChen Qianyu: WAIT 12s\nChen Qianyu: BS',
    );
    expect(timeline.extraHits.map((hit) => hit.frameIndex)).toEqual([2, 6]);
    expect(timeline.extraHits[0]).toMatchObject({ multiplier: 2.5, element: 'Physical' });
  });

  it('an extra hit is not a standing buff', () => {
    const { timeline } = play('Chen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: WAIT 1s');
    expect(timeline.frames.flat().some((buff) => buff.apply.stat === 'extra_hit')).toBe(false);
  });
});
