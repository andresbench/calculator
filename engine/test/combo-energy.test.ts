/**
 * A combo's energy is the sum of its energy rows by role (`export.py`,
 * `energy_roles`), not the first row called `Ultimate Energy Gain` (audit
 * 2026-11-12, В2). Last Rite's combo is 40 and 15 per Cryo Infliction stack it
 * ate, Rossi's sequences give 10 each, Yvonne's «Additional» and Zhuang
 * Fangyi's per-stack gain were never counted.
 *
 * The numbers come from the bundle's rows, not from memory.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  COMBO_ENERGY,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  statAt,
  type Bundle,
  type Frame,
  type Skill,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('combo energy', (bundle) => {
  const LEVEL = 12;

  function play(script: string, edit?: (data: Bundle) => void): Frame[] {
    const data = edit ? structuredClone(bundle) : bundle;
    edit?.(data);
    const rotation = parseRot(script, buildAliases(data));
    const members = teamOf(data, rotation.team, rotation.steps);
    return simulate(rotation.steps, members, data.timings ?? FALLBACK_TIMINGS, {
      synergy: data.synergy,
      sp: data.sp ?? FALLBACK_SP,
      unlimitedSp: true,
    }).frames;
  }

  function combo(operator: string): Skill {
    return bundle.operators[operator]!.skills.find((skill) => skill.type === 'Combo Skill')!;
  }

  /** The energy each step gave `who`: Last Rite's own combo is the only source in these scripts. */
  function gains(frames: Frame[], who: string): number[] {
    return frames.map((frame, index) => frame.energy[who]! - (index > 0 ? frames[index - 1]!.energy[who]! : 0));
  }

  function ate(frame: Frame, kind: 'consumesInfliction' | 'consumesVulnerable', who: string): number {
    return frame.status.reduce((sum, event) => sum + (event.kind === kind && event.by === who ? (event.consumed ?? 0) : 0), 0);
  }

  it('Last Rite: base plus 15 per Cryo Infliction stack the combo ate', () => {
    const base = statAt(combo('Last Rite'), 'Base Ultimate Energy Gain', LEVEL)!;
    const perStack = statAt(combo('Last Rite'), 'Additional Ultimate Energy Gain per Infliction Stack', LEVEL)!;
    expect([base, perStack]).toEqual([40, 15]);
    for (const stacks of [1, 2, 3, 4]) {
      // Estella's battle skill puts one Cryo Infliction stack on the target and lands at once.
      const script = ['team: Last Rite, Estella', ...Array<string>(stacks).fill('Estella: BS'), 'Last Rite: CS'].join('\n');
      const frames = play(script);
      const cast = frames.at(-1)!;
      expect(frames.at(-2)!.target.inflictions.Cryo).toBe(stacks);
      expect(ate(cast, 'consumesInfliction', 'Last Rite')).toBe(stacks);
      expect(gains(frames, 'Last Rite').at(-1)).toBe(base + perStack * stacks);
    }
  });

  it('Last Rite: a combo that ate nothing gives only the base', () => {
    const base = statAt(combo('Last Rite'), 'Base Ultimate Energy Gain', LEVEL)!;
    expect(gains(play('team: Last Rite\nLast Rite: CS'), 'Last Rite')).toEqual([base]);
  });

  it("Rossi: each sequence gives its own row, a lone CS gives both", () => {
    const first = statAt(combo('Rossi'), 'SEQ 1 Ultimate Energy Gain', LEVEL)!;
    const second = statAt(combo('Rossi'), 'SEQ 2 Ultimate Energy Gain', LEVEL)!;
    expect([first, second]).toEqual([10, 10]);
    expect(gains(play('team: Rossi\nRossi: CS1 > CS2'), 'Rossi')).toEqual([first, second]);
    expect(gains(play('team: Rossi\nRossi: CS'), 'Rossi')).toEqual([first + second]);
  });

  it("Yvonne: the combo's «Additional» comes when it hits, the dummy is always hit", () => {
    const base = statAt(combo('Yvonne'), 'Ultimate Energy Gain', LEVEL)!;
    const hit = statAt(combo('Yvonne'), 'Additional Ultimate Energy Gain', LEVEL)!;
    expect(hit).toBeGreaterThan(0);
    expect(gains(play('team: Yvonne\nYvonne: CS'), 'Yvonne')).toEqual([base + hit]);
  });

  it('Zhuang Fangyi: base plus 10 per Electric Infliction stack the Array ate', () => {
    const base = statAt(combo('Zhuang Fangyi'), 'Ultimate Energy Gain', LEVEL)!;
    const perStack = statAt(combo('Zhuang Fangyi'), 'Additional Ultimate Energy per Infliction Stack', LEVEL)!;
    expect(perStack).toBeGreaterThan(0);
    for (const stacks of [1, 3]) {
      const script = ['team: Zhuang Fangyi, Perlica', ...Array<string>(stacks).fill('Perlica: BS'), 'Zhuang Fangyi: CS'].join('\n');
      const frames = play(script);
      expect(ate(frames.at(-1)!, 'consumesInfliction', 'Zhuang Fangyi')).toBe(stacks);
      expect(gains(frames, 'Zhuang Fangyi').at(-1)).toBe(base + perStack * stacks);
    }
  });

  it('Laevatain: the row for one enemy, as the target is one', () => {
    const one = statAt(combo('Laevatain'), /Hitting 1 Enemy/, LEVEL)!;
    expect(gains(play('team: Laevatain\nLaevatain: CS'), 'Laevatain')).toEqual([one]);
  });

  it('a plain combo gives its one row, and Avywenna\'s row says nothing', () => {
    const chen = statAt(combo('Chen Qianyu'), 'Ultimate Energy Gain', LEVEL)!;
    expect(gains(play('team: Chen Qianyu\nChen Qianyu: CS'), 'Chen Qianyu')).toEqual([chen]);
    expect(gains(play('team: Avywenna\nAvywenna: CS'), 'Avywenna')).toEqual([0]);
  });

  it('a combo with no energy row at all falls back to COMBO_ENERGY', () => {
    const frames = play('team: Chen Qianyu\nChen Qianyu: CS', (data) => {
      const skill = data.operators['Chen Qianyu']!.skills.find((item) => item.type === 'Combo Skill')!;
      skill.stats = skill.stats.filter((row) => row.unit !== 'energy');
    });
    expect(gains(frames, 'Chen Qianyu')).toEqual([COMBO_ENERGY]);
  });

  it('every combo row of unit energy in the bundle has a role', () => {
    for (const [key, operator] of Object.entries(bundle.operators)) {
      for (const skill of operator.skills.filter((item) => item.type === 'Combo Skill')) {
        for (const row of skill.stats.filter((item) => item.unit === 'energy')) {
          expect(row.energy, `${key}: ${row.label}`).toBeDefined();
        }
      }
    }
  });
});
