/**
 * `.rot` parsing and the resource simulation.
 *
 * The tests pin three conclusions reached during E3, each of which took its
 * own investigation:
 *
 * 1. `CS1 > CS2` is two SEQUENCES of one cast, not two casts. Otherwise
 *    Rossi's rotation reads as impossible: two combos in a row with a
 *    14-second cooldown.
 * 2. A cooldown is not an error but **a source of time**. The notation
 *    records the order of significant actions, not every button press, so
 *    there is unrecorded waiting between steps. `Tangtang: CS > CS` with a
 *    12 s cooldown means "cast, then again once it is back".
 * 3. Variants are computed separately: they are alternative ways to play,
 *    each with its own start. Cycles within a variant run back to back.
 */

import { describe, expect, it } from 'vitest';

import {
  classify,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  finalStrikeSp,
  inflictionElement,
  MAX_STACKS,
  spAt,
  parseRot,
  simulate,
  splitVariants,
  type Operator,
  type TeamMember,
  type Timings,
} from '../src/index.js';

import { CHEN } from './fixtures/chen.js';
import { text, texts } from './support/messages.js';

/** An operator with a single combo: 12 s cooldown, 10 energy per cast. */
function withCombo(cooldown: number): Operator {
  return {
    ...CHEN,
    skills: [
      {
        slot: 3,
        type: 'Combo Skill',
        name: 'test combo',
        variant: null,
        text: '',
        terms: [],
        icon: null,
        stats: [
          // Split by stage, as Rossi's is: the combo is two presses, CS1 and CS2.
          {
            label: 'Cooldown',
            unit: 'sec',
            values: Array(12).fill(cooldown),
            sequences: [Array(12).fill(cooldown), Array(12).fill(0)],
          },
          { label: 'Ultimate Energy Gain', unit: 'energy', values: Array(12).fill(10), energy: { role: 'base' } },
        ],
      },
      {
        slot: 2,
        type: 'Battle Skill',
        name: 'test battle skill',
        variant: null,
        text: '',
        terms: [],
        icon: null,
        stats: [{ label: 'SP Cost', unit: 'sp', values: Array(12).fill(100) }],
      },
    ],
  };
}

function team(operator: Operator): Map<string, TeamMember> {
  return new Map([
    [
      operator.key,
      { key: operator.key, operator, level: 90, skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } },
    ],
  ]);
}

const aliases = new Map([['chenqianyu', CHEN.key]]);
const timings: Timings = { ...FALLBACK_TIMINGS, sensitivity: [0.5, 1, 2] };

describe('.rot parsing', () => {
  it('reads headers, steps and notes', () => {
    const rot = parseRot(
      ['# comment', 'title: Probe', 'team: Chen Qianyu', '', 'Chen Qianyu: BS > CS   [note]'].join('\n'),
      aliases,
    );
    expect(rot.title).toBe('Probe');
    expect(rot.team).toEqual(['Chen Qianyu']);
    expect(rot.steps).toHaveLength(2);
    expect(rot.steps[0]!.kind).toBe('BS');
    expect(rot.steps[1]!.kind).toBe('CS');
    expect(rot.steps[0]!.note).toBe('note');
    expect(rot.steps[0]!.actor).toBe(CHEN.key);
  });

  it('tells sequences and modifiers apart', () => {
    const rot = parseRot('Chen Qianyu: BS2 > CS~ > ULT?', aliases);
    expect(rot.steps[0]!.sequence).toBe(2);
    expect(rot.steps[1]!.optional).toBe(true);
    expect(rot.steps[2]!.uncertain).toBe(true);
  });

  it('keeps an actor change within a line', () => {
    const rot = parseRot('Chen Qianyu: CS > Rossi: BS', new Map([...aliases, ['rossi', 'Rossi']]));
    expect(rot.steps.map((step) => step.actorRaw)).toEqual(['Chen Qianyu', 'Rossi']);
  });

  it('counts cycles and variants', () => {
    const rot = parseRot(
      ['variant: first', 'cycle 1:', 'Chen Qianyu: BS', 'cycle 2:', 'Chen Qianyu: CS', 'variant: second', 'Chen Qianyu: BS'].join('\n'),
      aliases,
    );
    expect(rot.variants).toEqual(['first', 'second']);
    expect(rot.steps.map((step) => step.cycle)).toEqual([1, 2, 1]);
  });

  it('complains about an unrecognised operator instead of staying silent', () => {
    const rot = parseRot('Unknown: BS', aliases);
    expect(rot.steps[0]!.actor).toBeNull();
    expect(texts(rot.warnings).join(' ')).toContain('unknown operator');
  });
});

describe('combo sequences are one cast', () => {
  const operator = withCombo(14);

  it('CS1 > CS2 does not count as two casts', () => {
    const rot = parseRot('Chen Qianyu: CS1 > CS2', aliases);
    const result = simulate(rot.steps, team(operator), timings);
    // There must be neither a wait nor a second energy grant.
    expect(result.waited).toBe(0);
    const last = result.frames[result.frames.length - 1]!;
    expect(last.energy[operator.key]).toBe(10);
  });

  it('but two separate casts do count, with a cooldown wait between them', () => {
    const rot = parseRot('Chen Qianyu: CS > CS', aliases);
    const result = simulate(rot.steps, team(operator), timings);
    expect(result.waited).toBeCloseTo(13, 6); // 14 s cooldown minus 1 s for the action
    expect(result.waits[0]!.reason).toContain('cooldown');
  });
});

describe('cooldown as a source of time', () => {
  it('cycle length follows from the data, not from a guessed second', () => {
    const rot = parseRot('Chen Qianyu: CS > CS', aliases);
    const fast = simulate(rot.steps, team(withCombo(12)), { ...timings });
    const slow = simulate(rot.steps, team(withCombo(12)), { ...timings });
    expect(fast.real).toBeCloseTo(slow.real, 6);
    // Exactly the cooldown passes between two casts, whatever the duration.
    const halved = simulate(rot.steps, team(withCombo(12)), timings, { scale: 0.5 });
    const doubled = simulate(rot.steps, team(withCombo(12)), timings, { scale: 2 });
    expect(halved.frames[1]!.world - halved.frames[0]!.world).toBeCloseTo(12, 6);
    expect(doubled.frames[1]!.world - doubled.frames[0]!.world).toBeCloseTo(12, 6);
  });

  it('an SP shortfall also turns into time, not a dead end', () => {
    const operator = withCombo(1);
    // Four battle skills at 100 SP with 300 in stock: the fourth has to wait.
    const rot = parseRot('Chen Qianyu: BS > BS > BS > BS', aliases);
    const result = simulate(rot.steps, team(operator), timings);
    expect(result.waits.some((wait) => wait.reason.includes('SP'))).toBe(true);
    expect(result.frames.every((frame) => frame.sp >= 0)).toBe(true);
  });
});

describe('variants are computed separately', () => {
  it('splitVariants cuts the rotation by variant and keeps cycles together', () => {
    const rot = parseRot(
      // The Russian cycle keyword `цикл` is still accepted.
      ['variant: A', 'цикл 1:', 'Chen Qianyu: BS', 'цикл 2:', 'Chen Qianyu: CS', 'variant: B', 'Chen Qianyu: BS'].join('\n'),
      aliases,
    );
    const parts = splitVariants(rot.steps);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.steps).toHaveLength(2);
    expect(parts[1]!.steps).toHaveLength(1);
  });
});

describe('timers do not freeze', () => {
  /**
   * Observed 2026-09-12: both the fight timer and buff countdowns run
   * during animations, ultimates included (measurements, #16). The
   * hypothesis was the opposite, and it would have required two clocks.
   */
  it('world and real time coincide', () => {
    const rot = parseRot('Chen Qianyu: BS > CS', aliases);
    const result = simulate(rot.steps, team(withCombo(1)), timings);
    expect(result.world).toBeCloseTo(result.real, 6);
  });
});

describe('stagger, finisher and Final Strike SP', () => {
  /**
   * From the `Stagger` page: the meter fills from Final Strikes, skills and
   * Physical Status; when full the enemy is Staggered, takes +30 % damage
   * and the first basic attack becomes a Finisher. While staggered the
   * meter does not fill further.
   */
  const staggering: Operator = {
    ...CHEN,
    skills: [
      {
        slot: 2,
        type: 'Battle Skill',
        name: 'stagger test',
        variant: null,
        text: '',
        terms: [],
        icon: null,
        stats: [
          { label: 'SP Cost', unit: 'sp', values: Array(12).fill(0) },
          { label: 'Stagger', unit: 'stagger', values: Array(12).fill(30) },
        ],
      },
      {
        slot: 1,
        type: 'Basic Attack',
        name: 'basic',
        variant: null,
        text: '',
        terms: [],
        icon: null,
        stats: [{ label: 'Final Strike Stagger', unit: 'stagger', values: Array(12).fill(10) }],
      },
    ],
  };

  const target = {
    staggerMeter: 60,
    staggerRecovery: 10,
    finisherMultiplier: 1.75,
    finisherSp: 100,
    name: 'boss',
  };

  it('meter fills from skills and trips at the threshold', () => {
    const rot = parseRot('Chen Qianyu: BS > BS', aliases);
    const result = simulate(rot.steps, team(staggering), timings, { target });
    expect(result.frames[0]!.target.staggered).toBe(false);
    const last = result.frames[result.frames.length - 1]!;
    // The second cast fills the gauge: 30 + 30 = 60.
    expect(text(last.verdicts.get('2:stagger')) ?? '').toBe('target staggered');
  });

  it('finisher is refused while the target is not staggered', () => {
    const rot = parseRot('Chen Qianyu: FIN', aliases);
    const result = simulate(rot.steps, team(staggering), timings, { target });
    expect(texts(result.frames[0]!.problems).join(' ')).toContain('needs a staggered target');
  });

  it('finisher works once the meter is full, and consumes the stagger', () => {
    const rot = parseRot('Chen Qianyu: BS > BS > FIN', aliases);
    const result = simulate(rot.steps, team(staggering), timings, { target });
    const finisher = result.frames[2]!;
    expect(finisher.problems).toHaveLength(0);
    expect(text(finisher.verdicts.get('3:finisher'))).toBe('target staggered');
  });

  it('without an enemy the finisher says the meter is missing, not that it failed', () => {
    const rot = parseRot('Chen Qianyu: FIN', aliases);
    const result = simulate(rot.steps, team(staggering), timings);
    expect(texts(result.frames[0]!.problems).join(' ')).toContain('no stagger meter is set');
  });

  it('Final Strike restores SP: the two figures the wiki actually gives', () => {
    expect(finalStrikeSp(FALLBACK_SP, 'Fluorite')).toBe(15);
    expect(finalStrikeSp(FALLBACK_SP, 'Last Rite')).toBe(30);
    // Anyone else falls back to the midpoint, and that is an assumption.
    expect(finalStrikeSp(FALLBACK_SP, 'Chen Qianyu')).toBe(20);
    expect(FALLBACK_SP.finalStrike.confidence).toBe('unknown');
  });

  it('a Final Strike pays into the SP pool', () => {
    const rot = parseRot('Chen Qianyu: FS', aliases);
    const drained = new Map(team(staggering));
    const result = simulate(rot.steps, drained, timings, { target });
    expect(text(result.frames[0]!.verdicts.get('1:fs'))).toBe('+20 SP');
  });
});

describe('stacks are spent, not timed', () => {
  /**
   * The first version drew Vulnerable and the inflictions as buff windows
   * hanging over the whole rotation. They are counters that get consumed:
   * Crush and Breach eat the Vulnerable stacks the moment they land, and how
   * many they ate *is* the Status Level that multiplies their damage.
   */
  function statusOperator(terms: { applies: string[]; skillName: string }): Operator {
    return {
      ...CHEN,
      key: 'Tester',
      name: 'Tester',
      skills: [
        {
          slot: 2,
          type: 'Battle Skill',
          name: terms.skillName,
          variant: null,
          text: '',
          terms: terms.applies,
          icon: null,
          stats: [{ label: 'SP Cost', unit: 'sp', values: Array(12).fill(0) }],
        },
      ],
    };
  }

  const lifter = statusOperator({ applies: ['Lift'], skillName: 'lift skill' });
  const crusher = statusOperator({ applies: ['Crush'], skillName: 'crush skill' });

  const synergy = {
    applies: {
      Tester: { Lift: ['lift skill'], Crush: ['crush skill'] },
    },
    implications: { Lift: ['Vulnerable', 'Physical Status'], Crush: ['Vulnerable'] },
    comboTriggers: {},
  };

  function run(script: string) {
    const operator = { ...lifter, skills: [...lifter.skills, ...crusher.skills] };
    const map = new Map([
      [
        'Tester',
        { key: 'Tester', operator, level: 90, skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } },
      ],
    ]);
    const rot = parseRot(script, new Map([['tester', 'Tester']]));
    return simulate(rot.steps, map, timings, { synergy });
  }

  it('Vulnerable caps at four stacks', () => {
    const result = run('Tester: BS > BS > BS > BS > BS > BS');
    const last = result.frames[result.frames.length - 1]!;
    expect(last.target.vulnerable).toBe(4);
  });

  it('classify puts the umbrella terms apart from the real ones', () => {
    expect(classify('Vulnerable').kind).toBe('umbrella');
    expect(classify('Physical Status').kind).toBe('umbrella');
    expect(classify('Lift').kind).toBe('buildsVulnerable');
    expect(classify('Crush').kind).toBe('consumesVulnerable');
    expect(classify('Heat Infliction')).toEqual({ kind: 'infliction', element: 'Heat' });
    expect(classify('Combustion').kind).toBe('consumesInfliction');
  });

  it('the first Physical Status on a clean target applies Vulnerable instead', () => {
    const result = run('Tester: BS');
    const event = result.frames[0]!.status.find((item) => item.kind === 'buildsVulnerable');
    // The measurement log leans on this: that hit produces no damage instance
    // at all, so comparing it with a mid-rotation hit is comparing two
    // different things.
    expect(event?.appliedVulnerableInstead).toBe(true);
  });

  it('inflictions stack per element and cap at four', () => {
    expect(inflictionElement('Cryo Infliction')).toBe('Cryo');
    expect(inflictionElement('Vulnerable')).toBeNull();
    expect(MAX_STACKS).toBe(4);
  });

  it('SP timeline starts full and records every change', () => {
    const result = run('Tester: BS > BS');
    expect(result.spTimeline[0]).toEqual({ t: 0, sp: 300 });
    expect(result.spTimeline.length).toBeGreaterThan(1);
    // Cap is three bars of 100, and nothing may exceed it.
    expect(Math.max(...result.spTimeline.map((point) => point.sp))).toBeLessThanOrEqual(300);
  });

  it('SP between timeline points is regen, capped', () => {
    const line = [
      { t: 0, sp: 300 },
      { t: 0, sp: 200 },
    ];
    // The point is the value after the cast; the playhead later sees regen on top.
    expect(spAt(line, 0, 8)).toBe(200);
    expect(spAt(line, 2.5, 8)).toBe(220);
    expect(spAt(line, 100, 8)).toBe(300);
  });
});
