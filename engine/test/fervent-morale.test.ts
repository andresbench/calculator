/**
 * Pogranichnik's Tactical Instruction: «Any operator triggering the
 * ultimate's subsequent effects also gains Fervent Morale for 10s» — the
 * operator whose step spent a Steel Oath point gets a stack of their own
 * (ATK +8 %, Arts Intensity +8, up to 3). Measurements #62: the shield icon
 * with stacks on Chen during Steel Oath, her Lift Stagger above the model by
 * what +8 AI a stack gives.
 */

import { expect, it } from 'vitest';

import { activeEffects, buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, trackBuffs, type Bundle } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle("Fervent Morale from Pogranichnik's ultimate", (bundle: Bundle) => {
  const play = (script: string) => {
    const rotation = parseRot(`team: Pogranichnik, Chen Qianyu\n${script}`, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 1000 },
      ultimatesCharged: true,
    });
    const holders = [...team.keys()].map((key) => ({
      key,
      active: activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0 }),
    }));
    return { frames, timeline: trackBuffs(frames, holders) };
  };
  /** Fervent Morale ATK stacks on `who` after step `index`, from Tactical Instruction. */
  const stacks = (timeline: ReturnType<typeof play>['timeline'], index: number, who: string) =>
    timeline.after[index]!.filter(
      (buff) => buff.receiver === who && buff.apply.stat === 'atk_pct' && buff.effect.source.name === 'Tactical Instruction',
    ).reduce((sum, buff) => sum + buff.stacks, 0);

  it('the step that spent a point gives its operator a stack; three is the cap', () => {
    const { frames, timeline } = play('Pogranichnik: ULT\nChen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: BS');
    // Chen's first battle skill was Vulnerable instead of Lift: no point, no stack.
    expect(frames.map((frame) => frame.charges.length)).toEqual([0, 0, 1, 1, 1, 1]);
    expect([1, 2, 3, 4, 5].map((index) => stacks(timeline, index, 'Chen Qianyu'))).toEqual([0, 1, 2, 3, 3]);
    // Hers, not his: Chen's steps give Pogranichnik none.
    expect(stacks(timeline, 5, 'Pogranichnik')).toBe(0);
  });

  it('each stack lasts 10 s', () => {
    const { timeline } = play('Pogranichnik: ULT\nChen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: WAIT 11s\nChen Qianyu: BS');
    expect(stacks(timeline, 2, 'Chen Qianyu')).toBe(1);
    // The CS's stack has run out; the new battle skill brings one.
    expect(stacks(timeline, 4, 'Chen Qianyu')).toBe(1);
    expect(timeline.frames[4]!.some((buff) => buff.receiver === 'Chen Qianyu' && buff.effect.source.name === 'Tactical Instruction')).toBe(false);
  });
});
