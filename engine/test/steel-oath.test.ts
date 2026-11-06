/**
 * Pogranichnik's Steel Oath: points his ultimate generates and other steps
 * spend (`Synergy.charges`).
 *
 * «Generating 5 points of Steel Oath. After an enemy suffers a Physical
 * Status or takes DMG from Pogranichnik's combo skill, Pogranichnik consumes
 * 1 point … to harass the said enemy, dealing Physical DMG and recovering
 * some SP. When the last Steel Oath point is consumed, all 4 Shieldguards
 * will initiate a Decisive Assault». One point per step; four Harass, the
 * fifth point is the Decisive Assault alone; Chen's first Lift on a fresh
 * target is Vulnerable instead and spends nothing (measurements, #47).
 *
 * The SP is his: «recovering 80 SP with his own skills» (Fervent Morale)
 * counts it even when a teammate's step spent the point.
 */

import { expect, it } from 'vitest';

import {
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  activeEffects,
  parseRot,
  simulate,
  statAt,
  trackBuffs,
  trackDamage,
  type Build,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle("Pogranichnik's Steel Oath", (bundle) => {
  const ultimate = bundle.operators['Pogranichnik']!.skills.find((skill) => skill.type === 'Ultimate')!;
  const at12 = (label: string) => statAt(ultimate, label, 12)!;
  const play = (script: string) => {
    const rotation = parseRot(`team: Pogranichnik, Chen\n${script}`, new Map([['pogranichnik', 'Pogranichnik'], ['chen', 'Chen Qianyu']]));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    // SP is not what this is about: no step waits for it.
    return simulate(rotation.steps, team, FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 1000 },
      ultimatesCharged: true,
    });
  };
  const five = 'Pogranichnik: ULT\nChen: BS\nChen: BS\nChen: BS\nChen: BS\nChen: BS\nChen: BS';

  it('the ultimate generates the points and spends none itself', () => {
    const sim = play(five);
    expect(sim.frames[0]!.charges).toEqual([]);
    const gained = [...sim.frames[0]!.verdicts.values()].find((verdict) => verdict.code === 'chargesGained');
    expect(gained).toMatchObject({ term: 'Steel Oath', points: 5 });
  });

  it('a Physical Status spends one point a step; the fifth is the Decisive Assault alone', () => {
    const sim = play(five);
    const spent = sim.frames.map((frame) => frame.charges.map((charge) => (charge.last ? 'last' : charge.sp)));
    const harass = at12('Harass SP Recovery');
    const decisive = at12('Decisive Assault SP Recovery');
    // The first Lift on the fresh target was Vulnerable instead: no point.
    expect(spent).toEqual([[], [], [harass], [harass], [harass], [harass], ['last']]);
    expect(sim.frames[6]!.charges[0]!.sp).toBe(decisive);
    // The SP is Pogranichnik's, on Chen's steps.
    expect(sim.frames[2]!.spRecoveredBy).toEqual({ Pogranichnik: harass });
  });

  it('the points run out with Steel Oath Duration', () => {
    const seconds = at12('Steel Oath Duration');
    const sim = play(`Pogranichnik: ULT\nChen: WAIT ${seconds + 1}s\nChen: BS`);
    expect(sim.frames[2]!.charges).toEqual([]);
  });

  it('his own combo spends a point too', () => {
    const sim = play('Chen: BS\nPogranichnik: ULT\nPogranichnik: BS\nPogranichnik: CS');
    expect(sim.frames[3]!.step.kind).toBe('CS');
    expect(sim.frames[3]!.problems).toEqual([]);
    expect(sim.frames[3]!.charges).toHaveLength(1);
  });

  it("the SP Chen's steps spent counts towards Fervent Morale", () => {
    const sim = play(five);
    const active = activeEffects(bundle.effects, { operator: 'Pogranichnik', elite: 4, potential: 0 });
    const buffs = trackBuffs(sim.frames, [{ key: 'Pogranichnik', active }]);
    const fervent = (index: number) =>
      buffs.after[index]!.filter(
        (buff) => buff.apply.name === 'Fervent Morale' && buff.apply.stat === 'atk_pct' && buff.receiver === 'Pogranichnik',
      );
    // 4 × 10 + 40 = 80 at the fifth spent point: the first stack, not before.
    expect(fervent(5)).toEqual([]);
    expect(fervent(6).map((buff) => buff.stacks)).toEqual([1]);
  });

  it('Harass and Decisive Assault hit where the points are spent, not at the ultimate', () => {
    const sim = play(five);
    const pog: Build = { ...emptyBuild('Pogranichnik'), skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } };
    const damage = trackDamage(
      bundle,
      { frames: sim.frames, length: sim.real, team: ['Pogranichnik', 'Chen Qianyu'] },
      (key) => (key === 'Pogranichnik' ? pog : emptyBuild(key)),
      null,
    );
    const labels = (index: number) =>
      damage.steps[index]!.parts.filter((part) => part.by === 'Pogranichnik').map((part) => part.label);
    expect(labels(0)).toEqual(['Advance DMG Multiplier']);
    expect(labels(1)).toEqual([]);
    expect(labels(2)).toEqual(['Harass DMG Multiplier']);
    expect(labels(6)).toEqual(['Decisive Assault DMG Multiplier']);
  });
});
