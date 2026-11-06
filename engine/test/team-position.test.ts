/**
 * Squad position and combo priority.
 *
 * The game reads squad order in three places, and all three are here:
 *
 * 1. Combo Skill Priority — who casts first when combos trigger at once.
 *    It defaults to squad order.
 * 2. Si's ultimate cuts the remaining combo cooldown of slot 01 (talent
 *    Proxy's Patronage, `SetSkillCdAtOnce` with functionType 0 in the
 *    client).
 * 3. Si's battle skill applies Heat Infliction instead of Cryo if slot 01
 *    is a Heat operator.
 */

import { describe, expect, it } from 'vitest';

import {
  formatRot,
  parseRot,
  priorityOrder,
  simulate,
  FALLBACK_TIMINGS,
  type Operator,
  type Skill,
  type Synergy,
  type TeamMember,
} from '../src/index.js';

import { CHEN } from './fixtures/chen.js';
import { text, texts } from './support/messages.js';

function skill(type: Skill['type'], name: string, stats: Skill['stats'] = []): Skill {
  return { slot: 1, type, name, variant: null, text: '', terms: [], icon: null, stats };
}

const fill = (value: number): number[] => Array(12).fill(value);

function operator(key: string, element: Operator['element'], skills: Skill[]): Operator {
  return { ...CHEN, key, name: key, element, skills };
}

function squad(members: Array<[Operator, number?]>): Map<string, TeamMember> {
  return new Map(
    members.map(([op, elite]) => [
      op.key,
      {
        key: op.key,
        operator: op,
        level: 90,
        ...(elite != null ? { elite } : {}),
        skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 },
      },
    ]),
  );
}

const keys = (...names: string[]) => new Map(names.map((name) => [name.toLowerCase(), name]));

describe('combo priority', () => {
  const opener = operator('Opener', 'Physical', [
    skill('Battle Skill', 'open', [{ label: 'SP Cost', unit: 'sp', values: fill(0) }]),
  ]);
  const combo = (key: string, applies = 'nothing'): Operator =>
    operator(key, 'Physical', [
      skill('Combo Skill', `${key} combo`, [{ label: 'Cooldown', unit: 'sec', values: fill(10) }]),
      skill('Battle Skill', applies),
    ]);
  const a = combo('A');
  const b = { ...combo('B'), skills: [skill('Combo Skill', 'B combo', [{ label: 'Cooldown', unit: 'sec', values: fill(10) }])] };

  const synergy: Synergy = {
    applies: { Opener: { Mark: ['open'] }, B: { Echo: ['B combo'] } },
    implications: {},
    comboTriggers: {
      A: { skill: 'A combo', text: '', groups: [['Mark']] },
      B: { skill: 'B combo', text: '', groups: [['Mark']] },
    },
  };
  const names = keys('Opener', 'A', 'B');
  const run = (script: string, order: Operator[], priority?: string[]) =>
    simulate(
      parseRot(script, names).steps,
      squad(order.map((op) => [op])),
      FALLBACK_TIMINGS,
      { synergy, ...(priority ? { comboPriority: priority } : {}) },
    );
  const problems = (result: ReturnType<typeof run>) => texts(result.frames.flatMap((frame) => frame.problems));

  it('by default the team order decides', () => {
    expect(problems(run('Opener: BS\nA: CS\nB: CS', [opener, a, b]))).toEqual([]);
    const wrong = problems(run('Opener: BS\nB: CS\nA: CS', [opener, a, b]));
    expect(wrong).toHaveLength(1);
    expect(wrong[0]).toMatch(/triggered together with B's combo/);
  });

  it('a custom priority overrides the team order', () => {
    expect(problems(run('Opener: BS\nB: CS\nA: CS', [opener, a, b], ['B']))).toEqual([]);
    expect(priorityOrder(['Opener', 'A', 'B'], ['B'])).toEqual(['B', 'Opener', 'A']);
  });

  it('a combo opened by the previous combo is a chain, not a tie', () => {
    const chained: Synergy = {
      ...synergy,
      comboTriggers: { ...synergy.comboTriggers, A: { skill: 'A combo', text: '', groups: [['Echo']] } },
    };
    const result = simulate(
      parseRot('Opener: BS\nB: CS\nA: CS', names).steps,
      squad([[opener], [a], [b]]),
      FALLBACK_TIMINGS,
      { synergy: chained },
    );
    expect(result.frames.flatMap((frame) => frame.problems)).toEqual([]);
  });

  it('a consumption trigger is opened by the consumption, not by the stacks', () => {
    // Camille: "Heat Infliction consumed". Applying an infliction does not
    // open it — a reaction that consumed the stacks does.
    const heater = operator('Heater', 'Heat', [
      skill('Battle Skill', 'heat', [{ label: 'SP Cost', unit: 'sp', values: fill(0) }]),
    ]);
    const reactor = operator('Reactor', 'Heat', [
      skill('Combo Skill', 'Reactor combo', [{ label: 'Cooldown', unit: 'sec', values: fill(10) }]),
    ]);
    const eater = operator('Eater', 'Heat', [
      skill('Combo Skill', 'Eater combo', [{ label: 'Cooldown', unit: 'sec', values: fill(10) }]),
    ]);
    const consuming: Synergy = {
      applies: {
        Heater: { 'Heat Infliction': ['heat'] },
        Reactor: { Combustion: ['Reactor combo'] },
      },
      implications: {},
      comboTriggers: {
        Reactor: { skill: 'Reactor combo', text: '', groups: [['Heat Infliction']] },
        Eater: { skill: 'Eater combo', text: '', groups: [['Heat Infliction']], consumed: true },
      },
    };
    const result = simulate(
      parseRot('Heater: BS\nReactor: CS\nEater: CS', keys('Heater', 'Reactor', 'Eater')).steps,
      // Eater ranks above Reactor: were they simultaneous, the order would be wrong.
      squad([[eater], [heater], [reactor]]),
      FALLBACK_TIMINGS,
      { synergy: consuming },
    );
    expect(result.frames.flatMap((frame) => frame.problems)).toEqual([]);
  });
});

describe('Si: Proxy\'s Patronage cuts slot 01 combo cooldown', () => {
  const striker = operator('Striker', 'Heat', [
    skill('Combo Skill', 'strike', [{ label: 'Cooldown', unit: 'sec', values: fill(30) }]),
  ]);
  const painter = operator('Painter', 'Cryo', [
    skill('Ultimate', 'big ink', [{ label: 'Ultimate Energy Cost', unit: 'energy', values: fill(0) }]),
  ]);
  const rule = (seconds: number, elite: number) => ({
    kind: 'comboCooldownCut' as const,
    skill: 'big ink',
    slot: 1,
    seconds,
    elite,
    source: "Proxy's Patronage",
    text: '',
  });
  const synergy: Synergy = {
    applies: {},
    implications: {},
    comboTriggers: {},
    teamPosition: { Painter: [rule(10, 1), rule(20, 2)] },
  };
  const names = keys('Striker', 'Painter');
  const readyAfterUlt = (members: Array<[Operator, number?]>) => {
    const result = simulate(parseRot('Striker: CS\nPainter: ULT', names).steps, squad(members), FALLBACK_TIMINGS, {
      synergy,
    });
    return { frame: result.frames[1]!, cs: result.frames[0]! };
  };

  it('the highest level unlocked by elite applies, and only to the running cooldown', () => {
    const e2 = readyAfterUlt([[striker], [painter, 4]]);
    expect(e2.frame.cooldowns['Striker:Combo Skill']).toBeCloseTo(Math.max(e2.frame.world, 30 - 20), 6);
    expect(text(e2.frame.verdicts.get('2:cooldownCut'))).toMatch(/−20 s/);

    const e1 = readyAfterUlt([[striker], [painter, 1]]);
    expect(e1.frame.cooldowns['Striker:Combo Skill']).toBeCloseTo(30 - 10, 6);

    const e0 = readyAfterUlt([[striker], [painter, 0]]);
    expect(e0.frame.cooldowns['Striker:Combo Skill']).toBeCloseTo(30, 6);
  });

  it('it reads slot 01, whoever stands there', () => {
    const swapped = readyAfterUlt([[painter, 4], [striker]]);
    expect(swapped.frame.cooldowns['Striker:Combo Skill']).toBeCloseTo(30, 6);
    expect(text(swapped.frame.verdicts.get('2:cooldownCut'))).toMatch(/Painter \(slot 01\) combo was not on cooldown/);
  });
});

describe('Si: Heat instead of Cryo with a Heat operator in slot 01', () => {
  const painter = operator('Painter', 'Cryo', [
    skill('Battle Skill', 'brush', [{ label: 'SP Cost', unit: 'sp', values: fill(0) }]),
  ]);
  const hot = operator('Hot', 'Heat', []);
  const cold = operator('Cold', 'Cryo', []);
  const synergy: Synergy = {
    applies: { Painter: { 'Cryo Infliction': ['brush'], 'Heat Infliction': ['brush'] } },
    implications: {},
    comboTriggers: {},
    teamPosition: {
      Painter: [
        {
          kind: 'swapTerm',
          skill: 'brush',
          term: 'Cryo Infliction',
          alt: 'Heat Infliction',
          slot: 1,
          element: 'Heat',
          text: '',
        },
      ],
    },
  };
  const after = (first: Operator) =>
    simulate(parseRot('Painter: BS', keys('Painter')).steps, squad([[first], [painter]]), FALLBACK_TIMINGS, {
      synergy,
    }).frames[0]!.target.inflictions;

  it('applies exactly one of the two, chosen by slot 01', () => {
    expect(after(hot)).toMatchObject({ Heat: 1, Cryo: 0 });
    expect(after(cold)).toMatchObject({ Heat: 0, Cryo: 1 });
  });
});

describe('.rot: team order and priority', () => {
  const names = keys('Opener', 'A', 'B');

  it('team names resolve to keys and keep their order', () => {
    const rot = parseRot('team: B, Opener, A\npriority: A\nB: CS', names);
    expect(rot.team).toEqual(['B', 'Opener', 'A']);
    expect(rot.priority).toEqual(['A']);
  });

  it('priority survives a round trip', () => {
    const rot = parseRot('team: B, Opener, A\npriority: A, B\nB: CS', names);
    const again = parseRot(formatRot(rot, (key) => key), names);
    expect(again.priority).toEqual(['A', 'B']);
    expect(again.team).toEqual(['B', 'Opener', 'A']);
  });
});
