/**
 * Tangtang's Whirlpools (`Synergy.stocks`).
 *
 * Her combo «creates a Whirlpool. Up to 2 Whirlpools can exist»; her battle
 * skill «creates a Waterspout» and «consumes all nearby Whirlpools to create
 * additional Waterspouts and return some SP based on the number of
 * Waterspouts created»; «If the battle skill creates multiple Waterspouts,
 * they also apply Arts Susceptibility». P1: «For every Whirlpool consumed …
 * return 5 additional SP». Past the cap the oldest goes, and each
 * Waterspout hits the one target (measurements, #49).
 *
 * Passive regen is off, so a frame's SP change is the step's own.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simModifiersFor,
  simulate,
  statAt,
  trackDamage,
  type Build,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const MAXED = { basic: 12, battle: 12, combo: 12, ultimate: 12 };

describeWithBundle("Tangtang's Whirlpools", (bundle) => {
  const skill = (type: string) => bundle.operators['Tangtang']!.skills.find((item) => item.type === type)!;
  const at12 = (type: string, label: string) => statAt(skill(type), label, 12)!;
  const play = (script: string, potential = 0) => {
    const rotation = parseRot(`team: Tangtang\n${script}`, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    return simulate(rotation.steps, team, FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 0 },
      modifiers: simModifiersFor(bundle, team, () => potential),
    });
  };
  const made = (sim: ReturnType<typeof play>) => sim.frames.map((frame) => frame.stock?.made ?? null);
  const arts = (sim: ReturnType<typeof play>, index: number) =>
    sim.frames[index]!.target.debuffs.find((debuff) => debuff.term === 'Arts Susceptibility' && debuff.appliedAt === sim.frames[index]!.world);

  it('a battle skill without Whirlpools makes one Waterspout and no Arts Susceptibility', () => {
    const sim = play('Tangtang: BS');
    expect(made(sim)).toEqual([1]);
    expect(arts(sim, 0)).toBeUndefined();
  });

  it('each Whirlpool is one more Waterspout and its SP Return; several apply Arts Susceptibility', () => {
    const sim = play('Tangtang: BS\nTangtang: CS\nTangtang: CS\nTangtang: BS');
    expect(made(sim)).toEqual([1, null, null, 3]);
    const cost = at12('Battle Skill', 'SP Cost');
    const back = at12('Battle Skill', 'SP Return per Whirlpool');
    expect(sim.frames[3]!.sp - sim.frames[2]!.sp).toBe(-cost + 2 * back);
    expect(arts(sim, 3)?.level).toBe(3);
  });

  it('no more than two: a third Whirlpool pushes out the oldest', () => {
    const sim = play('Tangtang: BS\nTangtang: CS\nTangtang: CS\nTangtang: CS\nTangtang: BS');
    expect(sim.frames[4]!.stock).toEqual({ name: 'Whirlpool', spent: 2, made: 3 });
  });

  it('a Whirlpool runs out after its Duration', () => {
    const seconds = at12('Combo Skill', 'Whirlpool Duration (s)');
    const sim = play(`Tangtang: BS\nTangtang: CS\nTangtang: WAIT ${seconds + 1}s\nTangtang: BS`);
    expect(sim.frames[3]!.stock).toEqual({ name: 'Whirlpool', spent: 0, made: 1 });
  });

  it('P1 returns 5 more SP per Whirlpool', () => {
    const plain = play('Tangtang: BS\nTangtang: CS\nTangtang: BS');
    const p1 = play('Tangtang: BS\nTangtang: CS\nTangtang: BS', 1);
    expect(p1.frames[2]!.sp - plain.frames[2]!.sp).toBe(5);
  });

  it('the Waterspout row hits once per Waterspout', () => {
    const sim = play('Tangtang: BS\nTangtang: CS\nTangtang: CS\nTangtang: BS');
    const build: Build = { ...emptyBuild('Tangtang'), skills: MAXED };
    const damage = trackDamage(bundle, { frames: sim.frames, length: sim.real, team: ['Tangtang'] }, () => build, null);
    const spout = (index: number) => damage.steps[index]!.parts.find((part) => part.label.startsWith('DMG Multiplier (1 Waterspout)'))!;
    expect(spout(0).label).toBe('DMG Multiplier (1 Waterspout)');
    expect(spout(3).label).toBe('DMG Multiplier (1 Waterspout) × 3');
    expect(spout(3).nonCrit / spout(0).nonCrit).toBeCloseTo(3, 9);
  });
});
