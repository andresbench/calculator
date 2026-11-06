/**
 * Status damage instances from simulation events (`statusHits.ts`):
 * synthetic operators, rules from the wiki pages and the measurements.
 */

import { describe, expect, it } from 'vitest';

import {
  corrosionShred,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  statusDebuffs,
  statusHits,
  type Operator,
  type Skill,
  type Synergy,
  type TeamMember,
} from '../src/index.js';

import { CHEN } from './fixtures/chen.js';

const fill = (value: number): number[] => Array(12).fill(value);

function skill(type: Skill['type'], name: string): Skill {
  return { slot: 1, type, name, variant: null, text: '', terms: [], icon: null, stats: type === 'Battle Skill' ? [{ label: 'SP Cost', unit: 'sp', values: fill(0) }] : [] };
}

function operator(key: string, element: Operator['element'], battle: string): Operator {
  return { ...CHEN, key, name: key, element, skills: [skill('Basic Attack', `${key} basic`), skill('Battle Skill', battle)] };
}

function squad(...members: Operator[]): Map<string, TeamMember> {
  return new Map(
    members.map((op) => [op.key, { key: op.key, operator: op, level: 90, skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } }]),
  );
}

const cold = operator('Cold', 'Cryo', 'frost');
const leaf = operator('Leaf', 'Nature', 'leaf');
const fire = operator('Fire', 'Heat', 'flame');
const zap = operator('Zap', 'Electric', 'chain');
const brute = operator('Brute', 'Physical', 'smash');
const synergy: Synergy = {
  applies: {
    Cold: { 'Cryo Infliction': ['frost'] },
    Fire: { 'Heat Infliction': ['flame'] },
    Leaf: { 'Nature Infliction': ['leaf'] },
    Zap: { Electrification: ['chain'] },
    Brute: { Lift: ['smash'] },
  },
  implications: {},
  comboTriggers: {},
  forced: { Zap: { Electrification: ['chain'] } },
};
const keys = new Map(['Cold', 'Fire', 'Zap', 'Brute', 'Leaf'].map((name) => [name.toLowerCase(), name]));
const run = (script: string, reactionBonus?: Record<string, Record<string, number>>) =>
  simulate(parseRot(script, keys).steps, squad(cold, fire, zap, brute, leaf), FALLBACK_TIMINGS, {
    synergy,
    ...(reactionBonus ? { reactionBonus } : {}),
  });

describe('status hits', () => {
  it('a second stack of the same element bursts, for the one who applied it', () => {
    const sim = run('Cold: BS > BS');
    const hits = statusHits(sim.frames, sim.world);
    expect(hits[0]).toEqual([]);
    expect(hits[1]).toEqual([expect.objectContaining({ name: 'Cryo Burst', kind: 'artsBurst', multiplier: 1.6, by: 'Cold' })]);
  });

  it('a reaction hits once at its Status Level, in the incoming element', () => {
    const sim = run('Cold: BS > BS\nFire: BS');
    const reaction = statusHits(sim.frames, sim.world)[2]!.find((hit) => hit.kind === 'artsReaction')!;
    expect(reaction).toMatchObject({ name: 'Combustion', element: 'Heat', by: 'Fire', statusLevel: 2 });
    expect(reaction.multiplier).toBeCloseTo(2.4, 10);
  });

  it('Combustion ticks only while the track lasts', () => {
    const sim = run('Cold: BS\nFire: BS');
    const end = sim.frames[1]!.world + 3.5;
    const dot = statusHits(sim.frames, end)[1]!.find((hit) => hit.kind === 'dot')!;
    expect(dot).toMatchObject({ name: 'Combustion DoT', by: 'Fire', ticks: 3 });
    expect(dot.multiplier).toBeCloseTo(0.24, 10);
  });

  it('a forced reaction has no initial hit', () => {
    const sim = run('Zap: BS');
    expect(statusHits(sim.frames, sim.world)[0]).toEqual([]);
  });

  it('a Physical Status on a clean target is Vulnerable instead, and deals nothing', () => {
    const sim = run('Brute: BS > BS');
    const hits = statusHits(sim.frames, sim.world);
    expect(hits[0]).toEqual([]);
    expect(hits[1]).toEqual([expect.objectContaining({ name: 'Lift', kind: 'physicalStatus', multiplier: 1.2 })]);
  });

  it('Shatter belongs to the breaker, at the Status Level of the Solidification', () => {
    const sim = run('Fire: BS > BS > BS\nCold: BS\nBrute: BS');
    const shatter = statusHits(sim.frames, sim.world)[4]!.find((hit) => hit.name === 'Shatter')!;
    expect(shatter).toMatchObject({ by: 'Brute', statusLevel: 3, kind: 'shatter' });
    expect(shatter.multiplier).toBeCloseTo(4.8, 10);
  });

  it('Electrification debuffs Arts DMG Taken from the next step, scaled by the applier\'s AI', () => {
    const sim = run('Cold: BS\nZap: BS\nFire: BS');
    const { before, fresh } = statusDebuffs(sim.frames, () => ({ artsIntensity: 100 }));
    expect(fresh[1]!.map((buff) => buff.effect.id)).toEqual(['status.electrification']);
    expect(before[1]).toEqual([]);
    // SL I: 12 % × (3·100 + 300)/(100 + 300) = 18 %.
    expect(before[2]![0]!.apply.value).toBeCloseTo(0.18, 10);
  });

  describe('Corrosion', () => {
    it('follows the wiki table: start, a step a second, the cap after ten steps', () => {
      expect(corrosionShred(1, 0, 0)).toBeCloseTo(0.036, 10);
      expect(corrosionShred(1, 0, 3)).toBeCloseTo(0.036 + 3 * 0.0084, 10);
      expect(corrosionShred(1, 0, 3.9)).toBeCloseTo(0.036 + 3 * 0.0084, 10);
      expect(corrosionShred(1, 0, 10)).toBeCloseTo(0.12, 10);
      expect(corrosionShred(4, 0, 0)).toBeCloseTo(0.072, 10);
      expect(corrosionShred(4, 0, 30)).toBeCloseTo(0.24, 10);
    });

    it('scales with the applier\'s Arts Intensity, all three numbers', () => {
      // AI 100: ×1.5.
      expect(corrosionShred(4, 100, 0)).toBeCloseTo(0.108, 10);
      expect(corrosionShred(4, 100, 10)).toBeCloseTo(0.36, 10);
    });

    it('Weapon Honing raises only the cap: more steps to reach it', () => {
      // SL IV, ×1.3: the cap is 31.2; ten steps reach 24, fourteen 30.72, the fifteenth caps.
      expect(corrosionShred(4, 0, 10, 0.3)).toBeCloseTo(0.24, 10);
      expect(corrosionShred(4, 0, 14, 0.3)).toBeCloseTo(0.3072, 10);
      expect(corrosionShred(4, 0, 15, 0.3)).toBeCloseTo(0.312, 10);
    });

    it('a new Corrosion keeps a higher shred it inherits, and does not grow past it', () => {
      expect(corrosionShred(1, 0, 0, 0, 20.64)).toBeCloseTo(0.2064, 10);
      expect(corrosionShred(1, 0, 5, 0, 20.64)).toBeCloseTo(0.2064, 10);
      // Below the new cap it keeps growing from there.
      expect(corrosionShred(4, 0, 1, 0, 10)).toBeCloseTo(0.1168, 10);
    });

    it('Nature on Cryo shreds every element from the next step, by its Status Level', () => {
      const sim = run('Cold: BS > BS\nLeaf: BS\nCold: BS');
      expect(sim.frames[2]!.target.debuffs.find((debuff) => debuff.term === 'Corrosion')).toMatchObject({ level: 2, source: 'Leaf' });
      const { before, fresh } = statusDebuffs(sim.frames, () => ({ artsIntensity: 0 }));
      expect(fresh[2]![0]!.apply).toMatchObject({ stat: 'res_ignore', value: 0.048 });
      expect(fresh[2]![0]!.apply.element).toBeUndefined();
      const elapsed = sim.frames[3]!.world - sim.frames[2]!.world;
      expect(before[3]![0]!.apply.value).toBeCloseTo(corrosionShred(2, 0, elapsed), 10);
    });

    it('lasts 15 s, longer with the applier\'s Weapon Honing', () => {
      const plain = run('Cold: BS\nLeaf: BS');
      const honed = run('Cold: BS\nLeaf: BS', { Leaf: { Corrosion: 10 } });
      const until = (frames: typeof plain.frames) =>
        frames[1]!.target.debuffs.find((debuff) => debuff.term === 'Corrosion')!.expiresAt! - frames[1]!.world;
      expect(until(plain.frames)).toBeCloseTo(15, 10);
      expect(until(honed.frames)).toBeCloseTo(25, 10);
    });
  });
});
