/**
 * Arts Infliction by the wiki's rules (the `Arts Infliction`, `Arts
 * Reaction` and `Solidification` pages) and the triggers that watch it.
 *
 * The scenario it all started with: Last Rite battle skill → Tangtang
 * battle skill → Si battle skill → Si's Final Strike. Last Rite's battle
 * skill puts Cryo only on the next Final Strike; that is the third stack,
 * it opens Last Rite's combo ("3 or more"), her combo consumes the stacks,
 * and that opens Si's combo ("Cryo Infliction consumed").
 */

import { describe, expect, it } from 'vitest';

import {
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  type Operator,
  type Skill,
  type Synergy,
  type TeamMember,
} from '../src/index.js';

import { CHEN } from './fixtures/chen.js';
import { text, texts } from './support/messages.js';

const fill = (value: number): number[] => Array(12).fill(value);

function skill(type: Skill['type'], name: string, stats: Skill['stats'] = []): Skill {
  return { slot: 1, type, name, variant: null, text: '', terms: [], icon: null, stats };
}

const free = (name: string): Skill => skill('Battle Skill', name, [{ label: 'SP Cost', unit: 'sp', values: fill(0) }]);
const combo = (name: string): Skill => skill('Combo Skill', name, [{ label: 'Cooldown', unit: 'sec', values: fill(10) }]);

function operator(key: string, element: Operator['element'], skills: Skill[]): Operator {
  return { ...CHEN, key, name: key, element, skills: [skill('Basic Attack', `${key} basic`), ...skills] };
}

function squad(...members: Operator[]): Map<string, TeamMember> {
  return new Map(
    members.map((op) => [op.key, { key: op.key, operator: op, level: 90, skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } }]),
  );
}

const keys = (...names: string[]) => new Map(names.map((name) => [name.toLowerCase(), name]));

describe('inflictions follow the wiki', () => {
  const cold = operator('Cold', 'Cryo', [free('frost')]);
  const leaf = operator('Leaf', 'Nature', [free('leaf')]);
  const zap = operator('Zap', 'Electric', [free('chain')]);
  const synergy: Synergy = {
    applies: {
      Cold: { 'Cryo Infliction': ['frost'] },
      Leaf: { 'Nature Infliction': ['leaf'] },
      Zap: { Electrification: ['chain'] },
    },
    implications: {},
    comboTriggers: {},
    forced: { Zap: { Electrification: ['chain'] } },
  };
  const run = (script: string) =>
    simulate(parseRot(script, keys('Cold', 'Leaf', 'Zap')).steps, squad(cold, leaf, zap), FALLBACK_TIMINGS, { synergy });

  it('same element stacks and bursts, a different one reacts', () => {
    const result = run('Cold: BS > BS\nLeaf: BS');
    expect(result.frames[1]!.target.inflictions.Cryo).toBe(2);
    expect(text(result.frames[1]!.verdicts.get('2:burst'))).toMatch(/Cryo Burst/);
    // Nature on Cryo: Corrosion at Status Level 2, Cryo eaten, Nature not added.
    const last = result.frames[2]!;
    expect(last.target.inflictions).toMatchObject({ Cryo: 0, Nature: 0 });
    expect(text(last.verdicts.get('3:reaction'))).toMatch(/Corrosion, Status Level 2/);
  });

  const vulnerable = operator('Lifter', 'Physical', [free('lift')]);
  const rossi = operator('Rossi', 'Physical', [combo('blazing shadow')]);
  const withRossi = (script: string) =>
    simulate(
      parseRot(script, keys('Lifter', 'Zap', 'Leaf', 'Rossi')).steps,
      squad(vulnerable, zap, leaf, rossi),
      FALLBACK_TIMINGS,
      {
        synergy: {
          applies: { Lifter: { Lift: ['lift'] }, Zap: { 'Electric Infliction': ['chain'] }, Leaf: { 'Nature Infliction': ['leaf'] } },
          implications: { 'Electric Infliction': ['Arts Infliction'], 'Nature Infliction': ['Arts Infliction'] },
          comboTriggers: { Rossi: { skill: 'blazing shadow', text: '', groups: [['Vulnerable'], ['Arts Infliction']] } },
          consumes: { Rossi: { 'Arts Infliction': ['blazing shadow'] } },
        },
      },
    );

  it('the reacting infliction still opens an «Arts Infliction» trigger (measurements, #4)', () => {
    const result = withRossi('Lifter: BS\nZap: BS\nLeaf: BS\nRossi: CS');
    // In game: no stacks left, the enemy burns, Rossi's combo is lit.
    expect(result.frames[2]!.target.inflictions).toMatchObject({ Electric: 0, Nature: 0 });
    expect(result.frames.flatMap((frame) => frame.problems)).toEqual([]);
  });

  it('but there is nothing left to consume', () => {
    // Clean Rossi (ATK 911): SEQ 2 / ΣSEQ 1 = 1537 / 769 = 2.00 — no stack.
    expect(withRossi('Lifter: BS\nZap: BS\nLeaf: BS\nRossi: CS').frames[3]!.stacksForHit).toBe(0);
    expect(withRossi('Lifter: BS\nZap: BS\nZap: BS\nLeaf: BS\nRossi: CS').frames[4]!.stacksForHit).toBe(0);
    // Real stacks on the target are counted as they are.
    expect(withRossi('Lifter: BS\nZap: BS\nZap: BS\nRossi: CS').frames[3]!.stacksForHit).toBe(2);
  });

  it('a forced reaction leaves the stacks alone', () => {
    const result = run('Cold: BS > BS\nZap: BS');
    expect(result.frames[2]!.target.inflictions.Cryo).toBe(2);
  });

  it('an infliction lasts 20 seconds', () => {
    const slow = { ...FALLBACK_TIMINGS, defaults: { ...FALLBACK_TIMINGS.defaults, BS: 7 } };
    const result = simulate(parseRot('Cold: BS > Leaf: BS > Leaf: BS > Leaf: BS', keys('Cold', 'Leaf')).steps, squad(cold, leaf), slow, {
      synergy: { ...synergy, applies: { Cold: synergy.applies.Cold!, Leaf: { 'Cryo Infliction': ['leaf'] } } },
    });
    // 0 s, 7 s, 14 s stack Cryo; at 21 s the first stack's timer (reset at 14 s) still holds.
    expect(result.frames[3]!.target.inflictions.Cryo).toBe(4);
    const lone = simulate(parseRot('Cold: BS > Leaf: BS > Leaf: BS > Leaf: BS', keys('Cold', 'Leaf')).steps, squad(cold, leaf), slow, {
      synergy: { ...synergy, applies: { Cold: synergy.applies.Cold!, Leaf: {} } },
    });
    expect(lone.frames[3]!.target.inflictions.Cryo).toBe(0);
  });

  // A wait moves the clock before the cast, so the cast sees the target as it
  // is after the wait: stacks that ran out meanwhile are gone.
  it('a combo waiting out its cooldown does not see stacks that expired meanwhile', () => {
    const hunter = operator('Hunter', 'Cryo', [
      skill('Combo Skill', 'pounce', [{ label: 'Cooldown', unit: 'sec', values: fill(30) }]),
    ]);
    const result = simulate(parseRot('Cold: BS\nHunter: CS\nHunter: CS', keys('Cold', 'Hunter')).steps, squad(cold, hunter), FALLBACK_TIMINGS, {
      synergy: { ...synergy, comboTriggers: { Hunter: { skill: 'pounce', text: '', groups: [['Cryo Infliction']], min: { 'Cryo Infliction': 1 } } } },
    });
    // Cryo from 0 s lasts until 20 s; the second pounce waits until ~31 s.
    const second = result.frames[2]!;
    expect(second.world).toBeGreaterThan(20);
    expect(second.target.inflictions.Cryo).toBe(0);
    expect(text(second.verdicts.get('3:trigger'))).toBe('not open');
    expect(texts(second.problems).join()).toMatch(/Cryo Infliction/);
  });

  it('a battle skill waiting for SP lands on a target whose stacks expired meanwhile', () => {
    const costs300 = (name: string): Skill => skill('Battle Skill', name, [{ label: 'SP Cost', unit: 'sp', values: fill(300) }]);
    const drain = operator('Drain', 'Physical', [costs300('drain')]);
    const costly = operator('Costly', 'Nature', [costs300('thorn')]);
    const result = simulate(
      parseRot('Drain: BS\nCold: BS\nCostly: BS', keys('Drain', 'Cold', 'Costly')).steps,
      squad(drain, cold, costly),
      FALLBACK_TIMINGS,
      { synergy: { ...synergy, applies: { Cold: synergy.applies.Cold!, Costly: { 'Nature Infliction': ['thorn'] } } } },
    );
    // Drain empties the SP bar, Cold applies Cryo at ~1 s, and the thorn
    // waits ~38 s for 300 SP: by then the Cryo is gone and nothing reacts.
    const thorn = result.frames[2]!;
    expect(thorn.world).toBeGreaterThan(21);
    expect(text(thorn.verdicts.get('3:reaction'))).toBeUndefined();
    expect(thorn.target.inflictions).toMatchObject({ Cryo: 0, Nature: 1 });
  });
});

describe('Last Rite → Si chain', () => {
  const perfusion = free('perfusion');
  perfusion.stats.push({ label: 'Duration (s)', unit: 'sec', values: fill(15) });
  const lastRite = operator('LastRite', 'Cryo', [perfusion, combo('devourer')]);
  const tang = operator('Tang', 'Cryo', [free('waterspout')]);
  const si = operator('Si', 'Cryo', [free('brush'), combo('ink lung')]);
  const synergy: Synergy = {
    applies: {
      LastRite: { 'Cryo Infliction': ['perfusion'] },
      Tang: { 'Cryo Infliction': ['waterspout'] },
      Si: { 'Cryo Infliction': ['brush'] },
    },
    implications: {},
    comboTriggers: {
      LastRite: { skill: 'devourer', text: '', groups: [['Cryo Infliction']], min: { 'Cryo Infliction': 3 } },
      Si: { skill: 'ink lung', text: '', groups: [['Cryo Infliction', 'Heat Infliction']], consumed: true },
    },
    consumes: { LastRite: { 'Cryo Infliction': ['devourer'] } },
    deferred: { LastRite: { perfusion: 'FS' } },
  };
  const names = keys('LastRite', 'Tang', 'Si');
  const run = (script: string) =>
    simulate(parseRot(script, names).steps, squad(lastRite, tang, si), FALLBACK_TIMINGS, { synergy });
  const problems = (result: ReturnType<typeof run>) => texts(result.frames.flatMap((frame) => frame.problems));

  it('the battle skill lands on the next Final Strike, the third stack opens the combo', () => {
    const result = run('LastRite: BS\nTang: BS\nSi: BS\nSi: FS\nLastRite: CS\nSi: CS');
    expect(result.frames[0]!.target.inflictions.Cryo).toBe(0);
    expect(result.frames[3]!.target.inflictions.Cryo).toBe(3);
    expect(result.frames[4]!.target.inflictions.Cryo).toBe(0);
    expect(problems(result)).toEqual([]);
  });

  it('the Final Strike has to come within 15 seconds', () => {
    const slow = { ...FALLBACK_TIMINGS, defaults: { ...FALLBACK_TIMINGS.defaults, BS: 8 } };
    const result = simulate(
      parseRot('LastRite: BS\nTang: BS\nSi: BS\nSi: FS', names).steps,
      squad(lastRite, tang, si),
      slow,
      { synergy },
    );
    // BS at 0, 8, 16 → FS at 24 s: the 15 s window closed at 15 s.
    expect(result.frames[3]!.target.inflictions.Cryo).toBe(2);
    expect(texts(result.frames.flatMap((frame) => frame.problems)).join()).toMatch(/expired/);
  });

  it('two stacks are not three', () => {
    const result = run('Tang: BS\nSi: BS\nLastRite: CS');
    expect(problems(result).join()).toMatch(/×3/);
  });

  it('without the consumption Si has nothing to fire on', () => {
    const result = run('Tang: BS\nSi: BS\nSi: CS');
    expect(problems(result).join()).toMatch(/consumed/);
  });

  it('the track is told which combos are open', () => {
    const result = run('LastRite: BS\nTang: BS\nSi: BS\nSi: FS');
    expect(result.frames[3]!.combos.map((item) => item.key)).toContain('LastRite');
    expect(result.frames[2]!.combos.map((item) => item.key)).not.toContain('LastRite');
  });
});

describe('Shatter', () => {
  const freezer = operator('Freezer', 'Cryo', [free('lure')]);
  const lifter = operator('Lifter', 'Physical', [free('lift')]);
  const fisher = operator('Fisher', 'Cryo', [combo('angling')]);
  const synergy: Synergy = {
    applies: { Freezer: { Solidification: ['lure'] }, Lifter: { Lift: ['lift'] } },
    implications: {},
    comboTriggers: { Fisher: { skill: 'angling', text: '', groups: [['Arts Reaction']], consumed: true } },
    forced: { Freezer: { Solidification: ['lure'] } },
  };
  it('a Physical Status on a frozen target consumes Solidification', () => {
    const result = simulate(
      parseRot('Freezer: BS\nLifter: BS\nFisher: CS', keys('Freezer', 'Lifter', 'Fisher')).steps,
      squad(freezer, lifter, fisher),
      FALLBACK_TIMINGS,
      { synergy },
    );
    expect(text(result.frames[1]!.verdicts.get('2:shatter'))).toBeDefined();
    expect(result.frames.flatMap((frame) => frame.problems)).toEqual([]);
  });
});
