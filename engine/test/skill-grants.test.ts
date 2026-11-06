/**
 * Susceptibility and Amp a skill puts up itself (`Skill.grants`, `grantBuffs`).
 *
 * * Lifeng: «If the enemy struck by the last hit of this skill has no
 *   Vulnerability stacks, apply Physical Susceptibility» — a value row, a
 *   duration row, a condition.
 * * Ardelia: «If the target has Corrosion, then consume the Corrosion and
 *   apply Physical Susceptibility and Arts Susceptibility».
 * * Si: «grants temporary Cryo Amp and Heat Amp to the entire team» — every
 *   squad member, and only those elements.
 * * Liino, Xaihi, Gilberta, Arcane's WILL array: the value scales with an
 *   attribute or with Vulnerable stacks.
 * * Xaihi's Auxiliary Crystal: «After the controlled operator performs a
 *   Final Strike … This effect can trigger 2 times … grant the said operator
 *   a temporary Arts Amp».
 * * Potentials edit the skill's grant (`Effect.grants`): Lifeng's P1 «also
 *   triggers … to enemies with no more than 2 Vulnerability stacks», Mi Fu's
 *   «+5% and has +4s duration», Xaihi's P5 «1.1 times».
 * * Purrchena: «There is a chance … applies Arts Susceptibility» — applied,
 *   not counted.
 */

import { expect, it } from 'vitest';

import {
  activeEffects,
  analyse,
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  grantBuffs,
  grantValue,
  parseRot,
  simModifiersFor,
  simulate,
  statAt,
  type Build,
  type Frame,
  type Granter,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const LEVEL_12: Granter['skills'] = { 'Basic Attack': 12, 'Battle Skill': 12, 'Combo Skill': 12, Ultimate: 12 };

describeWithBundle('skill grants', (bundle) => {
  const skillOf = (operator: string, type: string, variant: string | null = null) =>
    bundle.operators[operator]!.skills.find((item) => item.type === type && (variant == null || item.variant === variant))!;
  const at12 = (operator: string, type: string, label: string) => statAt(skillOf(operator, type), label, 12)!;
  const mods = (operator: string, potential: number) =>
    activeEffects(bundle.effects, { operator, elite: 4, potential }).flatMap((effect) => effect.grants ?? []);
  const play = (team: string, script: string, potential = 0) => {
    const rotation = parseRot(`team: ${team}\n${script}`, buildAliases(bundle));
    const members = teamOf(bundle, rotation.team, rotation.steps);
    const sim = simulate(rotation.steps, members, FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 1000 },
      ultimatesCharged: true,
      modifiers: simModifiersFor(bundle, members, () => potential),
    });
    const keys = [...members.keys()];
    const granter = (key: string) => ({ skills: LEVEL_12, attributes: {}, mods: mods(key, potential) });
    return { sim, keys, grants: grantBuffs(bundle, sim.frames, keys, granter) };
  };
  const debuff = (frame: Frame, term: string) => frame.target.debuffs.find((item) => item.term === term);
  const verdicts = (frame: { verdicts: Map<string, { code: string }> }) => [...frame.verdicts.values()].map((v) => v.code);

  it("Lifeng's Physical Susceptibility: the row's value, the row's duration, from the next step", () => {
    const { sim, grants } = play('Lifeng', 'Lifeng: BS\nLifeng: WAIT 1s');
    const applied = debuff(sim.frames[0]!, 'Physical Susceptibility')!;
    expect(applied).toMatchObject({ source: 'Lifeng', skill: 'Turbid Avatar' });
    expect(applied.expiresAt! - applied.appliedAt).toBe(at12('Lifeng', 'Battle Skill', 'Physical Susceptibility Duration (s)'));
    expect(grants.before[0]).toEqual([]);
    expect(grants.fresh[0]!.map((buff) => buff.apply.value)).toEqual([at12('Lifeng', 'Battle Skill', 'Physical Susceptibility')]);
    expect(grants.before[1]!.map((buff) => [buff.receiver, buff.apply.stat, buff.apply.element])).toEqual([
      ['enemy', 'susceptibility', 'Physical'],
    ]);
  });

  it('…and not on a target that has Vulnerability stacks — not for a trigger either', () => {
    const { sim } = play('Lifeng, Chen', 'Chen: BS\nChen: BS\nLifeng: BS');
    expect(sim.frames[1]!.target.vulnerable).toBeGreaterThan(0);
    expect(debuff(sim.frames[2]!, 'Physical Susceptibility')).toBeUndefined();
    expect(sim.frames[2]!.applied).not.toContain('Physical Susceptibility');
    expect(sim.frames[2]!.applied).not.toContain('Susceptible');
    expect(verdicts(sim.frames[2]!)).toContain('grantWithheld');
  });

  it("Ardelia's Susceptibility waits for Corrosion", () => {
    const { sim } = play('Ardelia', 'Ardelia: BS');
    expect(debuff(sim.frames[0]!, 'Physical Susceptibility')).toBeUndefined();
    expect(debuff(sim.frames[0]!, 'Arts Susceptibility')).toBeUndefined();
  });

  it("Si's Amp reaches every squad member, for Cryo and Heat", () => {
    const { sim, keys, grants } = play('Si, Chen, Tangtang', 'Si: ULT\nChen: BS');
    const amp = at12('Si', 'Ultimate', 'Amp');
    const standing = grants.before[1]!.map((buff) => `${buff.apply.element}:${buff.receiver}:${buff.apply.value}`).sort();
    expect(standing).toEqual(keys.flatMap((key) => [`Cryo:${key}:${amp}`, `Heat:${key}:${amp}`]).sort());
    const applied = debuff(sim.frames[0]!, 'Cryo Amp')!;
    expect(applied.expiresAt! - applied.appliedAt).toBe(at12('Si', 'Ultimate', 'Amp Duration (s)'));
  });

  it('an elemental Amp does not touch the damage of another element', () => {
    const { grants } = play('Si, Chen, Tangtang', 'Si: ULT\nChen: BS');
    const dummy = { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} };
    const damage = (key: string, external: typeof grants.before[number]) => {
      const build: Build = { ...emptyBuild(key), skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } };
      const row = analyse(build, bundle, dummy, external)!.skills.find((item) => item.type === 'Battle Skill')!;
      return row.result.damage;
    };
    const chen = grants.before[1]!.filter((buff) => buff.receiver === 'Chen Qianyu');
    const tangtang = grants.before[1]!.filter((buff) => buff.receiver === 'Tangtang');
    expect(damage('Chen Qianyu', chen)).toBe(damage('Chen Qianyu', []));
    expect(damage('Tangtang', tangtang) / damage('Tangtang', [])).toBeCloseTo(1 + at12('Si', 'Ultimate', 'Amp'), 9);
  });

  it('values that scale: an attribute up to its cap, Vulnerable stacks, the WILL array', () => {
    const liino = skillOf('Liino', 'Ultimate');
    const nature = liino.grants!.find((grant) => grant.term === 'Nature Amp')!;
    const per = statAt(liino, 'Amp Increase per Will', 12)!;
    const cap = statAt(liino, 'MAX Amp from Will', 12)!;
    const base = { made: null, vulnerable: 0 };
    expect(grantValue(liino, nature, 12, { ...base, attributes: { WIL: 100 } })).toBeCloseTo(per * 100, 12);
    expect(grantValue(liino, nature, 12, { ...base, attributes: { WIL: 1e6 } })).toBe(cap);

    const gilberta = skillOf('Gilberta', 'Ultimate');
    const arts = gilberta.grants!.find((grant) => grant.term === 'Arts Susceptibility')!;
    expect(grantValue(gilberta, arts, 12, { made: null, vulnerable: 3, attributes: {} })).toBeCloseTo(
      statAt(gilberta, 'Base Arts Susceptibility', 12)! + 3 * statAt(gilberta, 'Arts Susceptibility Boost per Vulnerability', 12)!,
      12,
    );

    const arcane = skillOf('Arcane', 'Combo Skill', 'Array Arcana: WILL');
    const cryo = arcane.grants!.find((grant) => grant.term === 'Cryo Susceptibility')!;
    const full = statAt(arcane, 'Will for MAX Bonus Susceptibility', 12)!;
    expect(grantValue(arcane, cryo, 12, { ...base, attributes: { WIL: full / 2 } })).toBeCloseTo(
      statAt(arcane, 'Base Susceptibility', 12)! + statAt(arcane, 'Max Bonus Susceptibility from Will', 12)! / 2,
      12,
    );
  });

  it("Xaihi's crystal: Arts Amp on the striker, on two Final Strikes, not on the cast", () => {
    const { sim, grants } = play('Xaihi, Chen', 'Xaihi: BS\nChen: FS\nChen: FS\nChen: FS\nChen: WAIT 1s');
    expect(debuff(sim.frames[0]!, 'Arts Amp')).toBeUndefined();
    expect(sim.frames[0]!.applied).not.toContain('Arts Amp');
    expect(verdicts(sim.frames[0]!)).toContain('grantArmed');
    expect(sim.frames.map((frame) => verdicts(frame).includes('grantOnStrike'))).toEqual([false, true, true, false, false]);
    const amp = debuff(sim.frames[1]!, 'Arts Amp')!;
    expect(amp).toMatchObject({ source: 'Xaihi', receiver: 'Chen Qianyu' });
    expect(amp.expiresAt! - amp.appliedAt).toBe(at12('Xaihi', 'Battle Skill', 'Arts Amp Duration (s)'));
    expect(grants.before[2]!.map((buff) => [buff.receiver, buff.apply.element, buff.apply.value])).toEqual([
      ['Chen Qianyu', 'Arts', at12('Xaihi', 'Battle Skill', 'Arts Amp')],
    ]);
  });

  it("…within the crystal's duration", () => {
    const seconds = at12('Xaihi', 'Battle Skill', 'Auxiliary Crystal Duration (s)');
    const { sim } = play('Xaihi, Chen', `Xaihi: BS\nChen: WAIT ${seconds + 1}s\nChen: FS`);
    expect(debuff(sim.frames[2]!, 'Arts Amp')).toBeUndefined();
  });

  it("Lifeng's P1: up to 2 Vulnerability stacks, 5 % more", () => {
    const { sim, grants } = play('Lifeng, Chen', 'Chen: BS\nChen: BS\nLifeng: BS\nLifeng: WAIT 1s', 1);
    expect(sim.frames[1]!.target.vulnerable).toBe(2);
    expect(debuff(sim.frames[2]!, 'Physical Susceptibility')).toBeDefined();
    expect(grants.before[3]!.map((buff) => buff.apply.value)).toEqual([at12('Lifeng', 'Battle Skill', 'Physical Susceptibility') + 0.05]);
    const three = play('Lifeng, Chen', 'Chen: BS\nChen: BS\nChen: BS\nLifeng: BS', 1).sim;
    expect(three.frames[2]!.target.vulnerable).toBe(3);
    expect(debuff(three.frames[3]!, 'Physical Susceptibility')).toBeUndefined();
  });

  it("Mi Fu's P1 lasts 4 s longer; Xaihi's P5 is 1.1 times", () => {
    const mifu = play('Mi Fu', 'Mi Fu: CS', 1).sim;
    const applied = debuff(mifu.frames[0]!, 'Physical Susceptibility')!;
    expect(applied.expiresAt! - applied.appliedAt).toBe(at12('Mi Fu', 'Combo Skill', 'Physical Susceptibility Duration (s)') + 4);
    const plain = play('Xaihi', 'Xaihi: ULT\nXaihi: WAIT 1s', 0).grants.before[1]![0]!.apply.value;
    const p5 = play('Xaihi', 'Xaihi: ULT\nXaihi: WAIT 1s', 5).grants.before[1]![0]!.apply.value;
    expect(p5 / plain).toBeCloseTo(1.1, 12);
  });

  it("Purrchena's Arts Susceptibility is left to chance: applied, not counted", () => {
    const { sim, grants } = play('Purrchena', 'Purrchena: ULT\nPurrchena: WAIT 1s');
    expect(debuff(sim.frames[0]!, 'Arts Susceptibility')).toBeDefined();
    expect(grants.before[1]).toEqual([]);
    expect(grants.uncounted).toEqual([{ operator: 'Purrchena', term: 'Arts Susceptibility', reason: 'chance' }]);
  });
});
