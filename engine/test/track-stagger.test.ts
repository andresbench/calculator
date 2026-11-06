/**
 * Stagger on the track: which hits take the Staggered +30 % and the finisher's
 * multiplier.
 *
 * The rule (`trackDamage`): a step's hits and statuses count as hitting a
 * staggered target when the target was staggered as the step began. The
 * step that fills the meter does not get it (measurements, #45), a finisher
 * does, and so does nothing after the finisher has spent the stagger.
 *
 * Each case compares the same frames twice: as simulated, and with
 * `staggeredAtStart` forced off. Everything else — buffs, Link, statuses —
 * is the same in both, so the ratio is the stagger alone.
 */

import { expect, it } from 'vitest';

import {
  DUMMY,
  dummyTarget,
  emptyBuild,
  ENEMY_CLASSES,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  targetFor,
  trackDamage,
  type Build,
  type Frame,
  type Target,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

/** A real enemy with a finisher multiplier above 1. */
const ENEMY = 'Bonekrusher Pyromancer';

describeWithBundle('Staggered +30 % and the finisher on the track', (bundle) => {
  const enemy = bundle.enemies[ENEMY]!;
  const chen: Build = { ...emptyBuild('Chen Qianyu'), skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } };
  // A short meter, so that one battle skill after the ultimate fills it; the
  // damage side reads the enemy as it is.
  const target = { ...targetFor(bundle, ENEMY), staggerMeter: 50, staggerRecovery: 10 };
  const rotation = parseRot(
    'team: Chen\nChen: BS\nChen: ULT\nChen: BS\nChen: BS\nChen: FIN\nChen: BS',
    new Map([['chen', 'Chen Qianyu']]),
  );
  const team = teamOf(bundle, rotation.team, rotation.steps);
  const sim = simulate(rotation.steps, team, FALLBACK_TIMINGS, {
    synergy: bundle.synergy,
    target,
    ultimatesCharged: true,
  });
  const damageOf = (frames: Frame[]) =>
    trackDamage(bundle, { frames, length: sim.real, team: ['Chen Qianyu'] }, () => chen, ENEMY);
  const played = damageOf(sim.frames);
  const plain = damageOf(sim.frames.map((frame) => ({ ...frame, staggeredAtStart: false })));
  const ratio = (step: number) => played.steps[step]!.total / plain.steps[step]!.total;

  it('the frames: the meter fills at step 2, the finisher spends it at step 4', () => {
    expect(sim.frames.map((frame) => frame.staggeredAtStart)).toEqual([false, false, false, true, true, false]);
    expect(sim.frames[2]!.target.staggered).toBe(true);
    expect(sim.frames[4]!.target.staggered).toBe(false);
    expect(sim.frames[4]!.problems).toEqual([]);
  });

  it('the step that fills the meter hits an unstaggered target', () => {
    expect(played.steps[2]!.total).toBeGreaterThan(0);
    expect(ratio(2)).toBe(1);
  });

  it('a skill on a staggered target: ×1.3', () => {
    expect(ratio(3)).toBeCloseTo(1.3, 9);
  });

  it("the finisher: ×1.3 and the enemy's Finisher ATK Mult", () => {
    expect(enemy.finisherMultiplier).toBeGreaterThan(1);
    expect(ratio(4)).toBeCloseTo(1.3 * enemy.finisherMultiplier!, 9);
  });

  it('after the finisher the stagger is spent', () => {
    expect(ratio(5)).toBe(1);
  });

  it('the caveat is listed with the sum', () => {
    expect(played.notCounted.map((item) => item.message.code)).toContain('trackStaggerAtStart');
  });
});

describeWithBundle('the dummy with a typical stagger meter', (bundle) => {
  const ofClass = (enemyClass: string) =>
    Object.values(bundle.enemies).filter((enemy) => enemy.class === enemyClass && enemy.stagger.hp != null);
  const count = <T>(values: T[], value: T) => values.filter((item) => JSON.stringify(item) === JSON.stringify(value)).length;

  it('no class, or a class with no meter in the data, is the plain dummy', () => {
    expect(dummyTarget(bundle, null)).toBe(DUMMY);
    expect(dummyTarget(bundle, 'No Such Class')).toBe(DUMMY);
    expect(targetFor(bundle, null)).toBe(DUMMY);
  });

  it('every number is the most common one in its class', () => {
    for (const enemyClass of ENEMY_CLASSES) {
      const enemies = ofClass(enemyClass);
      if (enemies.length === 0) continue;
      const dummy = dummyTarget(bundle, enemyClass);
      const fields: Array<[unknown, unknown[]]> = [
        [dummy.staggerMeter, enemies.map((enemy) => enemy.stagger.hp)],
        [dummy.staggerRecovery, enemies.map((enemy) => enemy.stagger.recovery)],
        [dummy.staggerNodes, enemies.map((enemy) => enemy.stagger.nodes ?? [])],
        [dummy.finisherMultiplier, enemies.map((enemy) => enemy.finisherMultiplier ?? 1)],
        [dummy.finisherSp, enemies.map((enemy) => enemy.finisherSp ?? 0)],
      ];
      for (const [value, values] of fields) {
        const best = Math.max(...values.map((item) => count(values, item)));
        expect(count(values, value), `${enemyClass}: ${JSON.stringify(value)}`).toBe(best);
      }
    }
  });

  it("an enemy picked by key wins over the dummy's class", () => {
    const enemy = ofClass('Common')[0]!;
    expect(targetFor(bundle, enemy.key, 'Boss').name).toBe(enemy.key);
  });

  it("a finisher on the dummy takes the class's Finisher ATK Mult", () => {
    const boss: Target = { ...dummyTarget(bundle, 'Boss'), staggerMeter: 50 };
    expect(boss.finisherMultiplier).toBeGreaterThan(1);
    const chen: Build = { ...emptyBuild('Chen Qianyu'), skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } };
    const rotation = parseRot('team: Chen\nChen: BS\nChen: ULT\nChen: BS\nChen: FIN', new Map([['chen', 'Chen Qianyu']]));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const sim = simulate(rotation.steps, team, FALLBACK_TIMINGS, { synergy: bundle.synergy, target: boss, ultimatesCharged: true });
    expect(sim.frames[3]!.staggeredAtStart).toBe(true);
    const damageOf = (frames: Frame[]) =>
      trackDamage(bundle, { frames, length: sim.real, team: ['Chen Qianyu'], target: boss }, () => chen, null);
    const played = damageOf(sim.frames);
    const plain = damageOf(sim.frames.map((frame) => ({ ...frame, staggeredAtStart: false })));
    expect(played.steps[3]!.total / plain.steps[3]!.total).toBeCloseTo(1.3 * boss.finisherMultiplier, 9);
  });
});
