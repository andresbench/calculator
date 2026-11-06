/**
 * Crit and ATK a skill's own rows grant (`Skill.boosts`, `skillEffects`).
 *
 * * Rossi's combo: «COMBO SEQUENCE 2 … buffs Rossi's Critical Rate and
 *   Critical DMG Dealt» — on herself, from the second sequence.
 * * Rossi's ultimate: «When this skill successfully scores a critical hit, it
 *   deals higher Critical DMG» — its own hits only; P5 «Critical DMG Dealt is
 *   increased by +30%» likewise.
 * * Liino: «Cosmovoice Stance: This stance replaces Liino's Vocalist Stance»
 *   — one ATK Boost, not two.
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
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const MAXED = { basic: 12, battle: 12, combo: 12, ultimate: 12 };

describeWithBundle('skill boosts', (bundle) => {
  const at12 = (operator: string, type: string, label: string) =>
    statAt(bundle.operators[operator]!.skills.find((skill) => skill.type === type)!, label, 12)!;
  const build = (key: string, potential = 0): Build => ({ ...emptyBuild(key), skills: MAXED, potential });
  const run = (team: string, script: string) => {
    const rotation = parseRot(`team: ${team}\n${script}`, buildAliases(bundle));
    const sim = simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 1000 },
      ultimatesCharged: true,
    });
    return { sim, damage: trackDamage(bundle, { frames: sim.frames, length: sim.real, team: rotation.team }, build, null) };
  };
  const named = (list: Array<{ apply: { name?: string; stat: string; value: number }; receiver: string }>, name: string) =>
    list.filter((buff) => buff.apply.name === name);

  it("Rossi's crit buff comes with the combo's second sequence and stays on her", () => {
    const { sim, damage } = run('Rossi, Chen', 'Rossi: CS1 > CS2\nRossi: BS');
    expect(named(damage.standing[0]!, 'Critical Rate')).toEqual([]);
    const rate = named(damage.standing[1]!, 'Critical Rate');
    expect(rate.map((buff) => [buff.receiver, buff.apply.value])).toEqual([['Rossi', at12('Rossi', 'Combo Skill', 'Critical Rate')]]);
    expect(named(damage.standing[1]!, 'Critical DMG Boost').map((buff) => buff.apply.value)).toEqual([
      at12('Rossi', 'Combo Skill', 'Critical DMG Boost'),
    ]);
    expect((rate[0] as { until?: number }).until).toBeCloseTo(sim.frames[1]!.world + at12('Rossi', 'Combo Skill', 'Buff Duration (s)'), 9);
    // The battle skill after it is computed with it.
    expect(damage.steps[2]!.buffs.some((buff) => buff.apply.name === 'Critical Rate')).toBe(true);
  });

  it('…and a whole combo written as one step grants it too', () => {
    const { damage } = run('Rossi', 'Rossi: CS\nRossi: BS');
    expect(named(damage.standing[0]!, 'Critical Rate')).toHaveLength(1);
  });

  it("Rossi's ultimate crit damage reaches only her ultimate; P5 adds 30 % to it", () => {
    const dummy = { enemyKey: null, tier: 5, staggered: false, crit: true, assume: {} };
    const p0 = analyse(build('Rossi'), bundle, dummy)!;
    const p5 = analyse(build('Rossi', 5), bundle, dummy)!;
    const base = p0.sheet.critDmg;
    const ultimate = p0.skills.filter((row) => row.type === 'Ultimate');
    const battle = p0.skills.filter((row) => row.type === 'Battle Skill');
    expect(ultimate.map((row) => row.critDmg)).toEqual(ultimate.map(() => base + at12('Rossi', 'Ultimate', 'Critical DMG Boost')));
    expect(battle.map((row) => row.critDmg)).toEqual(battle.map(() => base));
    const crit = ultimate[0]!.result.factors.find((factor) => factor.id === 'crit')!;
    expect(crit.value).toBeCloseTo(1 + base + at12('Rossi', 'Ultimate', 'Critical DMG Boost'), 12);
    const p5ult = p5.skills.find((row) => row.type === 'Ultimate')!;
    expect(p5ult.critDmg - p5.sheet.critDmg).toBeCloseTo(at12('Rossi', 'Ultimate', 'Critical DMG Boost') + 0.3, 12);
    expect(p5.sheet.critDmg).toBe(base);
  });

  it("Liino's Cosmovoice Stance replaces the Vocalist one: one ATK Boost, the ultimate's duration", () => {
    const { sim, damage } = run('Liino, Chen', 'Liino: BS\nLiino: ULT\nChen: BS');
    const vocalist = named(damage.standing[0]!, 'ATK Boost');
    expect(vocalist.map((buff) => buff.receiver).sort()).toEqual(['Chen Qianyu', 'Liino']);
    const cosmovoice = named(damage.standing[1]!, 'ATK Boost');
    expect(cosmovoice).toHaveLength(2);
    for (const buff of cosmovoice) {
      expect((buff as { until?: number }).until).toBeCloseTo(
        sim.frames[1]!.world + at12('Liino', 'Ultimate', 'Cosmovoice Stance Duration (s)'),
        9,
      );
    }
  });
});
