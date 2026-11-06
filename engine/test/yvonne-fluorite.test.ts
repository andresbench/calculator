/**
 * Yvonne's barrage ultimate and Fluorite's explosive.
 *
 * * Yvonne: «Temporarily enhances Yvonne's basic attack (BATK). Each enhanced
 *   BATK sequence performed grants a stack of Critical Rate buff. After
 *   reaching max stacks, Yvonne also gains a Critical DMG buff.» Written as
 *   one `ULT` step for the whole window (`Skill.barrage`; measurements #52).
 * * Yvonne's Barrage of Technology: «After applying Solidification, the next
 *   basic attack performed becomes a Final Strike».
 * * Fluorite: «If an Improvised Explosive has been stuck to the target, the
 *   skill detonates it immediately and increases the DMG» (`Synergy.detonates`;
 *   measurements #53), and her combo and ultimate repeat the element already
 *   on the target (`Synergy.echoes`).
 */

import { expect, it } from 'vitest';

import {
  analyse,
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  statAt,
  trackDamage,
  type Build,
  type Bundle,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const MAXED = { basic: 12, battle: 12, combo: 12, ultimate: 12 };

describeWithBundle('Yvonne and Fluorite', (bundle) => {
  const skillOf = (operator: string, type: string) => bundle.operators[operator]!.skills.find((skill) => skill.type === type)!;
  const at12 = (operator: string, type: string, label: string) => statAt(skillOf(operator, type), label, 12)!;
  const build = (key: string): Build => ({ ...emptyBuild(key), skills: MAXED });
  const run = (team: string, script: string, data: Bundle = bundle) => {
    const rotation = parseRot(`team: ${team}\n${script}`, buildAliases(data));
    const sim = simulate(rotation.steps, teamOf(data, rotation.team, rotation.steps), FALLBACK_TIMINGS, {
      synergy: data.synergy,
      sp: { ...FALLBACK_SP, ...data.sp, passiveRegen: 1000 },
      ultimatesCharged: true,
    });
    return { sim, damage: trackDamage(data, { frames: sim.frames, length: sim.real, team: rotation.team }, build, null) };
  };
  const part = <T extends { label: string }>(parts: T[], prefix: string) => parts.find((item) => item.label.startsWith(prefix));

  it("Yvonne's ultimate is the whole window: its length, every shot, the closing strike", () => {
    const barrage = skillOf('Yvonne', 'Ultimate').barrage!;
    const { sim, damage } = run('Yvonne', 'Yvonne: ULT');
    expect(sim.frames[0]!.duration).toBe(barrage.seconds);
    expect(sim.frames[0]!.verdicts.get('1:barrage')).toEqual({ code: 'barrage', shots: barrage.shots, seconds: barrage.seconds });
    const labels = damage.steps[0]!.parts.map((item) => item.label);
    expect(labels).toEqual([`${barrage.row} × ${barrage.shots}`, 'Enhanced Final Strike DMG Multiplier']);
    expect(damage.notCounted.some((item) => item.message.code === 'trackBarrage')).toBe(true);
  });

  it('each shot carries the stacks the shots before it left; the closing strike carries them all', () => {
    const barrage = skillOf('Yvonne', 'Ultimate').barrage!;
    const sheet = analyse(build('Yvonne'), bundle, { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} })!.sheet;
    const perStack = at12('Yvonne', 'Ultimate', 'Critical Rate Boost per Stack');
    const atMax = at12('Yvonne', 'Ultimate', 'Critical DMG Boost at Max Stacks');
    const max = at12('Yvonne', 'Ultimate', 'Max Stacks');
    const factor = (stacks: number) =>
      1 + Math.min(1, sheet.critRate + stacks * perStack) * (sheet.critDmg + (stacks >= max ? atMax : 0));
    const shots = barrage.ramp.reduce((sum, [stacks, count]) => sum + count * factor(stacks), 0) / barrage.shots;

    const { damage } = run('Yvonne', 'Yvonne: ULT');
    const [shot, strike] = damage.steps[0]!.parts;
    expect(shot!.damage / shot!.nonCrit).toBeCloseTo(shots, 9);
    expect(strike!.damage / strike!.nonCrit).toBeCloseTo(factor(barrage.finalStacks), 9);
    expect(barrage.ramp[0]).toEqual([0, 1]);
  });

  it('the extra attack needs Solidification still up at the closing strike', () => {
    // Fluorite's Nature, Yvonne's battle skill solidifies; the closing strike comes after it runs out.
    const late = run('Yvonne, Fluorite', 'Fluorite: BS\nYvonne: BS\nYvonne: ULT');
    expect(late.sim.frames[2]!.verdicts.get('3:goneBeforeStrike:Solidification')).toMatchObject({ code: 'goneBeforeStrike' });
    expect(part(late.damage.steps[2]!.parts, 'Additional ATK')).toBeUndefined();

    // The same, had the strike come at once: the cast consumes it, and the extra attack lands.
    const ultimate = skillOf('Yvonne', 'Ultimate');
    const sooner: Bundle = {
      ...bundle,
      operators: {
        ...bundle.operators,
        Yvonne: {
          ...bundle.operators.Yvonne!,
          skills: bundle.operators.Yvonne!.skills.map((skill) =>
            skill === ultimate ? { ...skill, barrage: { ...skill.barrage!, strikeAt: 0.1 } } : skill,
          ),
        },
      },
    };
    const early = run('Yvonne, Fluorite', 'Fluorite: BS\nYvonne: BS\nYvonne: ULT', sooner);
    expect(early.sim.frames[2]!.status).toContainEqual(
      expect.objectContaining({ term: 'Solidification', kind: 'reactionConsumed', consumer: 'Yvonne' }),
    );
    expect(part(early.damage.steps[2]!.parts, 'Additional ATK')).toBeDefined();
  });

  it('after her battle skill solidifies, her next basic attack is one Final Strike', () => {
    const { sim, damage } = run('Yvonne, Fluorite', 'Fluorite: BS\nYvonne: BS\nYvonne: BA\nYvonne: BA');
    const strike = sim.frames[2]!;
    expect(strike.step.kind).toBe('FS');
    expect(strike.chained).toBe(true);
    expect(strike.verdicts.get('3:strikeAfter')).toEqual({ code: 'strikeAfter', talent: 'Barrage of Technology' });
    expect(damage.steps[2]!.parts.map((item) => item.label)).toEqual(['BATK SEQ 5 Multiplier']);
    // Once: the attack after it is the plain chain again.
    expect(sim.frames[3]!.step.kind).toBe('BA');
  });

  it("Fluorite's ultimate sets off her explosive: the hit moves to it, times the boost", () => {
    const { sim, damage } = run('Fluorite', 'Fluorite: BS\nFluorite: ULT');
    expect(sim.frames[1]!.detonated).toEqual({ skill: 'Tiny Surprise', step: 1, boost: 'Battle Skill DMG Boost' });
    expect(damage.steps[0]!.parts).toEqual([]);
    const boost = at12('Fluorite', 'Ultimate', 'Battle Skill DMG Boost');
    const blast = part(damage.steps[1]!.parts, 'Tiny Surprise: DMG Multiplier')!;
    const seq1 = part(damage.steps[1]!.parts, 'SEQ 1 DMG Multiplier')!;
    // Both under the ultimate step's buffs: the ratio is the multipliers'.
    expect(blast.nonCrit / seq1.nonCrit).toBeCloseTo(
      (at12('Fluorite', 'Battle Skill', 'DMG Multiplier') * (1 + boost)) / at12('Fluorite', 'Ultimate', 'SEQ 1 DMG Multiplier'),
      9,
    );
    expect(damage.notCounted.some((item) => item.message.code === 'trackFuse')).toBe(false);
  });

  it('…unless the fuse ran out first', () => {
    const fuse = bundle.synergy.detonates!.Fluorite!['Apex Prankster']!.fuse!;
    const { sim, damage } = run('Fluorite', `Fluorite: BS\nFluorite: WAIT ${fuse + 1}s\nFluorite: ULT`);
    expect(sim.frames[2]!.detonated).toBeNull();
    expect(part(damage.steps[0]!.parts, 'DMG Multiplier')).toBeDefined();
    expect(damage.notCounted.some((item) => item.message.code === 'trackFuse')).toBe(true);
  });

  it('her ultimate repeats only the element already there, from two stacks', () => {
    const one = run('Fluorite', 'Fluorite: BS\nFluorite: ULT');
    expect(one.sim.frames[1]!.target.inflictions).toMatchObject({ Nature: 1, Cryo: 0 });
    expect(one.sim.frames[1]!.verdicts.get('2:echo')).toEqual({ code: 'echoed', elements: [], min: 2 });
    const two = run('Fluorite', 'Fluorite: BS\nFluorite: BS\nFluorite: ULT');
    expect(two.sim.frames[2]!.target.inflictions).toMatchObject({ Nature: 3, Cryo: 0 });
    expect(two.sim.frames[2]!.target.debuffs.map((debuff) => debuff.term)).not.toContain('Solidification');
  });
});
