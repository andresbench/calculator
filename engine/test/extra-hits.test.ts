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
  const play = (
    text: string,
    gear: { sets?: Record<string, number>; weapon?: { name: string; columns: Record<string, number> } } = { sets: { Swordmancer: 3 } },
  ) => {
    const rotation = parseRot(text, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const key = [...team.keys()][0]!;
    const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      sp: bundle.sp ?? FALLBACK_SP,
      synergy: bundle.synergy,
    });
    const active = activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0, ...gear });
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

  it("Lifeng's Subduer of Evil hits on every Knock Down he applies, 100 % ATK at Elite 3", () => {
    // «Applying Knock Down also deals 100% ATK of Physical DMG.» The first
    // battle skill's Knock Down on a clean target becomes Vulnerable, as a
    // Lift does for Swordmancer (#60); the second is a Knock Down.
    const { timeline } = play('Lifeng: BS\nLifeng: WAIT 3s\nLifeng: BS\nLifeng: WAIT 3s', {});
    expect(timeline.extraHits.map((hit) => hit.frameIndex)).toEqual([2]);
    expect(timeline.extraHits[0]).toMatchObject({ name: 'Subduer of Evil', multiplier: 1, element: 'Physical' });
  });

  it("Valiant's extra Physical hit follows a Physical Status, at the weapon's column", () => {
    const weapon = bundle.weapons.Valiant!;
    const columns = Object.fromEntries(weapon.components.map((component) => [component.key, 4]));
    const { timeline } = play('Chen Qianyu: BS\nChen Qianyu: WAIT 3s\nChen Qianyu: BS\nChen Qianyu: WAIT 3s', { weapon: { name: 'Valiant', columns } });
    const valiant = timeline.extraHits.filter((hit) => hit.name === 'Valiant hit');
    // The second battle skill's Lift (the first is Vulnerable on a clean target, #60).
    expect(valiant.map((hit) => hit.frameIndex)).toEqual([2]);
    // The value is the named effect's {1} at column 4, as a fraction of ATK.
    const named = weapon.components.find((component) => component.textTemplate?.includes('{1}'))!;
    expect(valiant[0]!.multiplier).toBeCloseTo(named.valuesByRank[1]![3]!, 6);
  });

  it('an extra hit is not a standing buff', () => {
    const { timeline } = play('Chen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: WAIT 1s');
    expect(timeline.frames.flat().some((buff) => buff.apply.stat === 'extra_hit')).toBe(false);
  });
});
