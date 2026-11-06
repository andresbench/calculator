/**
 * Buffs by track frame (`buffs.ts`): a synthetic rotation, synthetic
 * effects. The rules come from measurements: a trigger takes effect from
 * the next step (#23), a buff with one id from two wearers is one buff
 * (#29), an elemental Amp is an Amp (#29).
 */

import { describe, expect, it } from 'vitest';

import {
  formatMessage,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  termMatches,
  trackBuffs,
  type Effect,
  type EffectApply,
  type Operator,
  type Skill,
  type Synergy,
  type TeamMember,
} from '../src/index.js';

import { CHEN } from './fixtures/chen.js';

const fill = (value: number): number[] => Array(12).fill(value);

function skill(type: Skill['type'], name: string, stats: Skill['stats'] = []): Skill {
  return { slot: 1, type, name, variant: null, text: '', terms: [], icon: null, stats };
}

/** A battle skill with no cost that recovers `sp` SP. */
const battle = (name: string, sp = 0): Skill =>
  skill('Battle Skill', name, [
    { label: 'SP Cost', unit: 'sp', values: fill(0) },
    ...(sp > 0 ? [{ label: 'SP Recovery', unit: 'sp' as const, values: fill(sp), sp: { kind: 'recovery' as const, when: 'always' as const } }] : []),
  ]);

function operator(key: string, skills: Skill[]): Operator {
  return { ...CHEN, key, name: key, skills: [skill('Basic Attack', `${key} basic`), ...skills] };
}

function squad(...members: Operator[]): Map<string, TeamMember> {
  return new Map(
    members.map((op) => [op.key, { key: op.key, operator: op, level: 90, skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } }]),
  );
}

function effect(id: string, apply: Partial<EffectApply> & Pick<EffectApply, 'stat' | 'value'>, extra: Partial<Effect> = {}): Effect {
  return {
    id,
    operator: null,
    source: { kind: 'gear-set', name: id, condition: '3-piece' },
    group: id,
    groupMode: 'highest',
    tier: 3,
    requires: {},
    text: null,
    seen: null,
    stale: false,
    confidence: 'confirmed',
    apply: [{ unit: 'frac', rawValue: apply.value * 100, target: 'self', trigger: null, ...apply }],
    ...extra,
  };
}

const keys = (...names: string[]) => new Map(names.map((name) => [name.toLowerCase(), name]));

describe('buffs on the track', () => {
  const giver = operator('Giver', [battle('refund', 20)]);
  const other = operator('Other', [battle('plain')]);
  const third = operator('Third', [battle('plain')]);
  const frontiers = effect('frontiers', { stat: 'dmg_bonus', value: 0.16, trigger: 'sp_recovered', target: 'team', duration: 15 });

  const run = (script: string, members = [giver, other]) =>
    simulate(parseRot(script, keys(...members.map((m) => m.key))).steps, squad(...members), FALLBACK_TIMINGS);

  it('a recovered-SP team buff lands from the next step, on everyone', () => {
    const sim = run('Giver: BS\nOther: BS');
    expect(sim.frames[0]!.spRecovered).toBe(20);
    const buffs = trackBuffs(sim.frames, [{ key: 'Giver', active: [frontiers] }, { key: 'Other', active: [] }]);
    expect(buffs.frames[0]).toEqual([]);
    expect(buffs.frames[1]!.map((buff) => buff.receiver).sort()).toEqual(['Giver', 'Other']);
  });

  it('the same buff from two wearers is one instance', () => {
    const twin = operator('Twin', [battle('refund', 20)]);
    const sim = run('Giver: BS\nTwin: BS\nOther: BS', [giver, twin, other]);
    const buffs = trackBuffs(sim.frames, [
      { key: 'Giver', active: [frontiers] },
      { key: 'Twin', active: [frontiers] },
      { key: 'Other', active: [] },
    ]);
    const onOther = buffs.frames[2]!.filter((buff) => buff.receiver === 'Other');
    expect(onOther).toHaveLength(1);
    expect(onOther[0]!.stacks).toBe(1);
  });

  it('expires after its duration', () => {
    const short = effect('short', { stat: 'dmg_bonus', value: 0.1, trigger: 'sp_recovered', target: 'team', duration: 0.5 });
    const sim = run('Giver: BS\nOther: BS > BS > BS');
    const buffs = trackBuffs(sim.frames, [{ key: 'Giver', active: [short] }, { key: 'Other', active: [] }]);
    const last = buffs.frames[buffs.frames.length - 1]!;
    expect(sim.frames[sim.frames.length - 1]!.world).toBeGreaterThan(0.5);
    expect(last).toEqual([]);
  });

  it('"recover 80 SP" stacks once per threshold, and a potential can lower it', () => {
    const big = operator('Big', [battle('refund', 50)]);
    const morale = effect(
      'morale',
      { stat: 'atk_pct', value: 0.08, trigger: 'sp_recovered:80', target: 'self', duration: 20, stacks: { max: 3, perTrigger: 1 }, name: 'Fervent Morale' },
    );
    const sim = run('Big: BS > BS > BS > BS', [big]);
    // 50, 100, 150, 200: thresholds 80 and 160 — two stacks by the last step.
    const plain = trackBuffs(sim.frames, [{ key: 'Big', active: [morale] }]);
    expect(plain.frames[3]!.find((buff) => buff.receiver === 'Big')?.stacks).toBe(1);
    // P3: threshold 60 and +2 to the cap. 50, 100 (60), 150 (120), 200 (180).
    const p3 = effect('p3', { stat: 'atk_pct', value: 0 }, { apply: [], modifies: { effect: 'Fervent Morale', stacksMax: 2, trigger: 'sp_recovered:60' } });
    const lowered = trackBuffs(sim.frames, [{ key: 'Big', active: [morale, p3] }]);
    expect(lowered.frames[3]!.find((buff) => buff.receiver === 'Big')?.stacks).toBe(2);
  });

  it('applies:Amp is closed by an elemental Amp', () => {
    expect(termMatches('Arts Amp', 'Amp')).toBe(true);
    expect(termMatches('Cryo Amp', 'Amp')).toBe(true);
    expect(termMatches('Physical Susceptibility', 'Susceptibility')).toBe(true);
    expect(termMatches('Heat Infliction', 'Arts Infliction')).toBe(true);
    expect(termMatches('Lift', 'Physical Status')).toBe(true);
    expect(termMatches('Amplifier', 'Amp')).toBe(false);
  });

  it('applies: a debuff on the target from the applier, from the next step on', () => {
    const marker = operator('Marker', [battle('mark')]);
    const synergy: Synergy = { applies: { Marker: { 'Arts Amp': ['mark'] } }, implications: {}, comboTriggers: {} };
    const sim = simulate(parseRot('Marker: BS\nOther: BS', keys('Marker', 'Other')).steps, squad(marker, other), FALLBACK_TIMINGS, { synergy });
    const xiranite = effect('xiranite', { stat: 'dmg_bonus', value: 0.16, trigger: 'applies:Amp|applies:Weakness', target: 'others', duration: 15 });
    const buffs = trackBuffs(sim.frames, [{ key: 'Marker', active: [xiranite] }, { key: 'Other', active: [] }]);
    expect(buffs.frames[1]!.map((buff) => buff.receiver)).toEqual(['Other']);
  });

  it('"× stacks consumed" takes its strength from what the step ate', () => {
    const lifter = operator('Lifter', [battle('lift')]);
    const crusher = operator('Crusher', [battle('crush')]);
    const synergy: Synergy = {
      applies: { Lifter: { Lift: ['lift'] }, Crusher: { Crush: ['crush'] } },
      implications: {},
      comboTriggers: {},
    };
    // The first Lift on a clean target is Vulnerable instead; the second adds a stack.
    const sim = simulate(
      parseRot('Lifter: BS > BS > BS\nCrusher: BS\nLifter: BS', keys('Lifter', 'Crusher')).steps,
      squad(lifter, crusher),
      FALLBACK_TIMINGS,
      { synergy },
    );
    const edge = effect('edge', {
      stat: 'dmg_bonus',
      value: 0.06,
      element: 'Physical',
      trigger: 'applies:Crush|applies:Breach',
      duration: 20,
      stacks: { max: 4, perTrigger: 1, from: 'consumed' },
    });
    const buffs = trackBuffs(sim.frames, [{ key: 'Lifter', active: [] }, { key: 'Crusher', active: [edge] }]);
    expect(sim.frames[3]!.status.find((event) => event.term === 'Crush')?.consumed).toBe(3);
    expect(buffs.frames[4]!.find((buff) => buff.receiver === 'Crusher')?.stacks).toBe(3);
  });

  it('a "next battle skill" buff is spent by that cast', () => {
    const smash = effect('smash', {
      stat: 'dmg_bonus',
      value: 0.3,
      skillType: 'Battle Skill',
      trigger: 'cast:Basic Attack',
      spentBy: 'cast:Battle Skill',
    });
    const sim = run('Other: BA > BS > BS', [other]);
    const buffs = trackBuffs(sim.frames, [{ key: 'Other', active: [smash] }]);
    expect(buffs.frames[1]).toHaveLength(1);
    expect(buffs.frames[2]).toEqual([]);
  });

  it('what the dummy cannot do is a note, not a silent zero', () => {
    const sim = run('Giver: BS', [giver, third]);
    const hurt = effect('hurt', { stat: 'atk_pct', value: 0.1, trigger: 'damage_taken', duration: 7 });
    const buffs = trackBuffs(sim.frames, [{ key: 'Giver', active: [hurt] }, { key: 'Third', active: [] }]);
    expect(buffs.notes.map((note) => formatMessage(note)).join('\n')).toMatch(/never fires on the dummy/);
  });

  it('a Final Strike trigger doubles for the controlled wielder, and only for them', () => {
    const prince = effect('prince', { stat: 'atk_pct', value: 0.1, trigger: 'final_strike', duration: 8 });
    prince.apply.push({ ...prince.apply[0]!, controlled: true });
    const sim = run('Giver: FS\nOther: BS\nGiver: BA');
    const holders = [{ key: 'Giver', active: [prince] }, { key: 'Other', active: [] }];
    // A Final Strike on the track is the controlled operator's: both rows.
    expect(trackBuffs(sim.frames, holders).frames[1]!.filter((buff) => buff.receiver === 'Giver')).toHaveLength(2);
    // The same strike with control elsewhere: the plain row alone.
    const elsewhere = sim.frames.map((frame) => ({ ...frame, controlled: 'Other' }));
    expect(trackBuffs(elsewhere, holders).frames[1]!.filter((buff) => buff.receiver === 'Giver')).toHaveLength(1);
    // A plain basic attack is not a Final Strike.
    const basic = run('Giver: BA\nOther: BS');
    expect(trackBuffs(basic.frames, holders).frames[1]).toEqual([]);
  });
});
