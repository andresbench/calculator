/**
 * Laevatain's ultimate enhances her basic attack (`Skill.enhancedBasic`).
 *
 * «For a certain duration, her basic attacks (BATK) are enhanced and the
 * Sviga Lævi strikes together with Laevatain … BATK sequence 3 also applies
 * Heat Infliction. Casting the battle skill, Smouldering Fire, or the combo
 * skill, Seethe, does not shorten the duration of the ultimate, Twilight.»
 *
 * The rows are the ultimate's (`Enhanced BATK SEQ 1–4`), at its level; the
 * chain's timings, its Final Strike's SP and Stagger and the hits' kind —
 * Basic Attack to the client — come from the client's frames
 * (`frames.py`, `enhancedChain`; measurements #54).
 */

import { describe, expect, it } from 'vitest';

import {
  analyse,
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simModifiersFor,
  simulate,
  statAt,
  targetFor,
  trackDamage,
  type Build,
  type Bundle,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const MAXED = { basic: 12, battle: 12, combo: 12, ultimate: 12 };

describeWithBundle('Laevatain: the enhanced basic attack of her ultimate', (bundle) => {
  const skillOf = (type: string) => bundle.operators.Laevatain!.skills.find((skill) => skill.type === type)!;
  const enhanced = skillOf('Ultimate').enhancedBasic!;
  const build = (key: string): Build => ({ ...emptyBuild(key), skills: MAXED });
  const run = (script: string, data: Bundle = bundle, target = targetFor(data, null)) => {
    const rotation = parseRot(`team: Laevatain\n${script}`, buildAliases(data));
    const sim = simulate(rotation.steps, teamOf(data, rotation.team, rotation.steps), FALLBACK_TIMINGS, {
      synergy: data.synergy,
      sp: { ...FALLBACK_SP, ...data.sp, passiveRegen: 1000 },
      ultimatesCharged: true,
      target,
    });
    return { sim, damage: trackDamage(data, { frames: sim.frames, length: sim.real, team: rotation.team }, build, null) };
  };
  const labels = (parts: Array<{ label: string }>) => parts.map((item) => item.label);

  it('the export reads the window, the pausing skills and the chain from the client', () => {
    expect(enhanced).toMatchObject({
      move: 'Enhanced BATK',
      window: 'Duration (s)',
      pausedBy: ['Battle Skill', 'Combo Skill'],
      applies: [{ sequence: 3, term: 'Heat Infliction' }],
      sequences: 4,
    });
    const rows = skillOf('Ultimate').stats.filter((row) => row.move === enhanced.move);
    expect(rows.map((row) => [row.hit?.sequence, row.hit?.part, row.dealtAs])).toEqual([
      [1, 'chain', 'Basic Attack'],
      [2, 'chain', 'Basic Attack'],
      [3, 'chain', 'Basic Attack'],
      [4, 'chain', 'Basic Attack'],
    ]);
  });

  it('inside the window `BA > FS` is the enhanced chain, at its own timings; outside, the plain one', () => {
    const { sim, damage } = run('Laevatain: BA > FS\nLaevatain: ULT\nLaevatain: BA > FS');
    expect(labels(damage.steps[0]!.parts)).toEqual(['BATK SEQ 1 Multiplier', 'BATK SEQ 2 Multiplier', 'BATK SEQ 3 Multiplier', 'BATK SEQ 4 Multiplier']);
    expect(labels(damage.steps[1]!.parts)).toEqual(['BATK SEQ 5 Multiplier']);
    // The ultimate's own cast deals none of the chain.
    expect(damage.steps[2]!.parts).toEqual([]);
    expect(sim.frames[2]!.verdicts.get('3:enhancedBasic')).toMatchObject({ code: 'enhancedBasicGained', move: 'Enhanced BATK' });
    expect(sim.frames[3]!.enhancedBasic).toEqual({ move: 'Enhanced BATK', skill: 'Twilight' });
    expect(labels(damage.steps[3]!.parts)).toEqual([
      'Enhanced BATK SEQ 1 Multiplier',
      'Enhanced BATK SEQ 2 Multiplier',
      'Enhanced BATK SEQ 3 Multiplier',
    ]);
    expect(labels(damage.steps[4]!.parts)).toEqual(['Enhanced BATK SEQ 4 Multiplier']);
    expect(sim.frames[3]!.duration).toBeCloseTo(enhanced.sequenceSeconds! - enhanced.finalStrikeSeconds!, 9);
    expect(sim.frames[4]!.duration).toBe(enhanced.finalStrikeSeconds);
  });

  it('the hits are the ultimate rows at the ultimate level', () => {
    const { damage } = run('Laevatain: ULT\nLaevatain: FS');
    const parts = damage.steps[1]!.parts;
    const ultimate = skillOf('Ultimate');
    expect(parts[3]!.nonCrit / parts[0]!.nonCrit).toBeCloseTo(
      statAt(ultimate, 'Enhanced BATK SEQ 4 Multiplier', 12)! / statAt(ultimate, 'Enhanced BATK SEQ 1 Multiplier', 12)!,
      9,
    );
  });

  it('its Final Strike restores its own SP and deals its own Stagger', () => {
    const target = { ...targetFor(bundle, null), staggerMeter: 1000, staggerRecovery: 10 };
    const { sim } = run('Laevatain: ULT\nLaevatain: BA > FS\nLaevatain: WAIT 20s\nLaevatain: BA > FS', bundle, target);
    expect(sim.frames[2]!.verdicts.get('3:fs')).toEqual({ code: 'finalStrikeSp', sp: enhanced.finalStrikeSp });
    expect(sim.frames[2]!.target.stagger - sim.frames[1]!.target.stagger).toBe(enhanced.finalStrikeStagger);
    // The plain chain after the window: the wiki's 18 Stagger, the client's 20 SP.
    expect(sim.frames[5]!.target.stagger - sim.frames[4]!.target.stagger).toBe(skillOf('Basic Attack').finalStrikeStagger);
    expect(enhanced.finalStrikeSp).not.toBe(bundle.sp!.basicAttack!.Laevatain!.finalStrikeSp);
  });

  it('Heat Infliction comes from the third sequence, not from the cast', () => {
    const { sim } = run('Laevatain: ULT\nLaevatain: BA > FS\nLaevatain: FS');
    expect(sim.frames[0]!.applied).toEqual([]);
    expect(sim.frames[1]!.applied).toEqual([{ term: 'Heat Infliction', by: 'Laevatain' }]);
    // A chained Final Strike is the fourth sequence alone.
    expect(sim.frames[2]!.applied).toEqual([]);
    // A Final Strike on its own walks the whole chain, the third sequence too.
    expect(sim.frames[3]!.applied).toEqual([{ term: 'Heat Infliction', by: 'Laevatain' }]);
  });

  it('the window lasts its Duration, and her battle skill pauses it', () => {
    const seconds = statAt(skillOf('Ultimate'), 'Duration (s)', 12)!;
    // The ultimate and battle skill steps themselves take part of the window
    // (the ultimate: its cutscene, from the client's frames).
    const probe = run('Laevatain: ULT\nLaevatain: BS');
    const ultimate = probe.sim.frames[0]!.duration;
    const battle = probe.sim.frames[1]!.duration;
    const late = run(`Laevatain: ULT\nLaevatain: WAIT ${seconds - ultimate + 0.5}s\nLaevatain: BA`);
    expect(late.sim.frames[2]!.enhancedBasic).toBeNull();
    const paused = run(`Laevatain: ULT\nLaevatain: BS\nLaevatain: WAIT ${seconds - ultimate - battle + 0.5}s\nLaevatain: BA`);
    const cast = paused.sim.frames[1]!;
    expect(cast.verdicts.get('2:enhancedPaused')).toMatchObject({ code: 'enhancedBasicPaused', until: seconds + cast.duration });
    expect(paused.sim.frames[3]!.enhancedBasic).not.toBeNull();
  });

  it('the hits take Basic Attack DMG bonuses, not Ultimate ones', () => {
    // A permanent Basic Attack DMG +50 % on her, borrowed from an existing layer entry.
    const template = bundle.effects.entries.find((entry) => entry.apply.some((apply) => apply.stat === 'dmg_bonus' && !apply.trigger))!;
    const { element: _, ...plain } = template.apply[0]!;
    const withBonus = (data: Bundle): Bundle => ({
      ...data,
      effects: {
        ...data.effects,
        entries: [
          ...data.effects.entries,
          {
            ...template,
            id: 'test.laevatain.basic-attack-dmg',
            operator: 'Laevatain',
            item: null,
            requires: {},
            apply: [{ ...plain, stat: 'dmg_bonus', skillType: 'Basic Attack', value: 0.5, rawValue: 50, trigger: null, target: 'self' }],
          },
        ],
      },
    });
    const enhancedRow = (data: Bundle) =>
      analyse(build('Laevatain'), data, { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} })!.skills.find(
        (row) => row.label === 'Enhanced BATK SEQ 1 Multiplier',
      )!.result.damage;
    expect(enhancedRow(withBonus(bundle)) / enhancedRow(bundle)).toBeCloseTo(1.5 / 1, 2);

    // Without the client's kind, the row would be an ultimate's and miss the bonus.
    const asUltimate: Bundle = {
      ...bundle,
      operators: {
        ...bundle.operators,
        Laevatain: {
          ...bundle.operators.Laevatain!,
          skills: bundle.operators.Laevatain!.skills.map((skill) => ({
            ...skill,
            stats: skill.stats.map(({ dealtAs: _dealtAs, ...row }) => row),
          })),
        },
      },
    };
    expect(enhancedRow(withBonus(asUltimate)) / enhancedRow(asUltimate)).toBeCloseTo(1, 9);
  });

  it("the Magma Fragment's DMG over time ticks ten times, by the client's summon", () => {
    const row = skillOf('Battle Skill').stats.find((item) => item.label === 'DMG Over Time Multiplier per SEQ')!;
    expect(row.hit?.count).toBe(10);
    const { damage } = run('Laevatain: BS');
    const parts = damage.steps[0]!.parts;
    const tick = parts.find((part) => part.label.startsWith('DMG Over Time'))!;
    expect(tick.label).toBe('DMG Over Time Multiplier per SEQ × 10');
    const explosion = parts.find((part) => part.label === 'Base Explosion DMG Multiplier')!;
    expect(tick.nonCrit / explosion.nonCrit).toBeCloseTo(
      (10 * statAt(skillOf('Battle Skill'), 'DMG Over Time Multiplier per SEQ', 12)!) /
        statAt(skillOf('Battle Skill'), 'Base Explosion DMG Multiplier', 12)!,
      9,
    );
    // Nothing left to list as «hit count unknown».
    expect(damage.notCounted.some((item) => item.message.code === 'trackHitCount')).toBe(false);
  });

  describe('her battle skill inside the ultimate', () => {
    const labelsOf = (parts: Array<{ label: string }>) => parts.map((part) => part.label).filter((label) => !label.includes('Burst'));

    it('the export marks the swapped-in rows and the strikes that inflict', () => {
      const battle = skillOf('Battle Skill');
      expect(battle.duringUltimate).toEqual({
        move: 'During Ultimate',
        ultimate: 'Twilight',
        applies: [
          { sequence: 1, term: 'Heat Infliction' },
          { sequence: 2, term: 'Heat Infliction' },
        ],
      });
      expect(battle.stats.find((row) => row.label === 'During Ultimate: Additional ATK Multiplier')?.hit?.when).toBe('consumes:Melting Flame');
    });

    it('inside the window it is two strikes and two Heat Infliction; outside, the Magma Fragment', () => {
      const { sim, damage } = run('Laevatain: BS\nLaevatain: ULT\nLaevatain: BS');
      expect(labelsOf(damage.steps[0]!.parts)).toEqual(['Base Explosion DMG Multiplier', 'DMG Over Time Multiplier per SEQ × 10']);
      expect(sim.frames[2]!.duringUltimate).toBe('During Ultimate');
      expect(labelsOf(damage.steps[2]!.parts)).toEqual(['During Ultimate: BATK SEQ 1 Multiplier', 'During Ultimate: BATK SEQ 2 Multiplier']);
      expect(sim.frames[2]!.applied).toEqual([
        { term: 'Heat Infliction', by: 'Laevatain' },
        { term: 'Heat Infliction', by: 'Laevatain' },
      ]);
      expect(sim.frames[2]!.target.inflictions.Heat).toBe(2);
      // Its Stagger is the two strikes', not the Magma Fragment's and every other row's.
      const at = (label: string) => statAt(skillOf('Battle Skill'), label, 12)!;
      const meter = { ...targetFor(bundle, null), staggerMeter: 10_000, staggerRecovery: 10 };
      const staggered = run('Laevatain: ULT\nLaevatain: BS', bundle, meter).sim;
      expect(staggered.frames[1]!.target.stagger - staggered.frames[0]!.target.stagger).toBe(
        at('During Ultimate: BATK SEQ 1 Stagger') + at('During Ultimate: BATK SEQ 2 Stagger'),
      );
    });

    it('at 4 Melting Flame it spends them for its own extra attack and Combustion, without the energy', () => {
      // BS, CS, FS — 3 stacks; the ultimate; the fourth from the battle skill inside it; then the spender.
      const { sim, damage } = run('Laevatain: BS\nLaevatain: CS\nLaevatain: FS\nLaevatain: ULT\nLaevatain: BS\nLaevatain: BS');
      const spender = sim.frames[5]!;
      expect(spender.verdicts.get('6:ownStacks')).toEqual({ code: 'ownStacksSpent', term: 'Melting Flame', spent: 4, energy: 0 });
      expect(labelsOf(damage.steps[5]!.parts)).toEqual([
        'During Ultimate: BATK SEQ 1 Multiplier',
        'During Ultimate: BATK SEQ 2 Multiplier',
        'During Ultimate: Additional ATK Multiplier',
        expect.stringMatching(/^Combustion DoT/),
      ]);
    });
  });

  describe('Melting Flame', () => {
    const entry = bundle.synergy.ownStacks!.Laevatain!;
    const squad = (team: string, script: string) => {
      const rotation = parseRot(`team: ${team}\n${script}`, buildAliases(bundle));
      const sim = simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), FALLBACK_TIMINGS, {
        synergy: bundle.synergy,
        sp: { ...FALLBACK_SP, ...bundle.sp, passiveRegen: 1000 },
        ultimatesCharged: true,
      });
      return { sim, damage: trackDamage(bundle, { frames: sim.frames, length: sim.real, team: rotation.team }, build, null) };
    };
    const count = (frame: { verdicts: Map<string, unknown> }) =>
      [...frame.verdicts.values()].filter((item) => (item as { code: string }).code === 'ownStacksGained').map((item) => (item as { count: number }).count).pop();

    it('the export reads the gains, the spender and the talent', () => {
      expect(entry).toMatchObject({
        name: 'Melting Flame',
        max: 4,
        gains: [
          { skill: 'Smouldering Fire', count: 1 },
          { skill: 'Seethe', count: 1 },
        ],
        spentBy: { skill: 'Smouldering Fire', at: 4, applies: ['Combustion'], energy: 'Additional ATK Ultimate Energy Gain' },
        absorbs: { talent: 'Scorching Heart', term: 'Heat Infliction', count: 1 },
        finalStrike: 1,
      });
      // «consume all the stacks … and forcibly trigger temporary Combustion»: the stacks, not Combustion.
      expect(bundle.synergy.consumes?.Laevatain?.Combustion).toBeUndefined();
    });

    it('battle skill, combo and her Final Strike add one each; the fourth battle skill spends them', () => {
      const { sim, damage } = run('Laevatain: BS\nLaevatain: CS\nLaevatain: FS\nLaevatain: BS\nLaevatain: BS');
      expect(sim.frames.slice(0, 4).map(count)).toEqual([1, 2, 3, 4]);
      const extra = (step: number) => damage.steps[step]!.parts.some((part) => part.label === 'Additional ATK DMG Multiplier');
      expect([0, 3].map(extra)).toEqual([false, false]);
      expect(sim.frames[0]!.verdicts.get('1:ownStacks')).toEqual({ code: 'ownStacksShort', term: 'Melting Flame', have: 0, need: 4 });
      expect(sim.frames[0]!.applied).toEqual([]);

      const spender = sim.frames[4]!;
      expect(spender.verdicts.get('5:ownStacks')).toMatchObject({ code: 'ownStacksSpent', spent: 4 });
      expect(extra(4)).toBe(true);
      expect(spender.applied).toEqual([{ term: 'Combustion', by: 'Laevatain' }]);
      // Its own Magma Fragment adds nothing: the stacks go with the extra attack.
      expect(count(spender)).toBeUndefined();
      // The extra attack's Ultimate Energy, on top of the 100 SP cast's.
      const energy = statAt(skillOf('Battle Skill'), 'Additional ATK Ultimate Energy Gain', 12)!;
      expect(spender.verdicts.get('5:ownStacks')).toMatchObject({ energy });
    });

    it("the talent absorbs the target's Heat Infliction after a Final Strike, without consuming it", () => {
      const { sim } = squad('Laevatain, Wulfgard', 'Wulfgard: BS\nWulfgard: FS');
      const heat = sim.frames[0]!.target.inflictions.Heat!;
      expect(heat).toBeGreaterThan(0);
      const strike = sim.frames[1]!;
      expect(strike.verdicts.get('2:absorbs:Laevatain')).toMatchObject({ code: 'ownStacksAbsorbed', absorbed: heat });
      expect(strike.target.inflictions.Heat).toBe(0);
      expect(count(strike)).toBe(Math.min(entry.max, heat));
      // Absorbing is not consuming: nothing on the track says the infliction was consumed.
      expect(strike.status.some((event) => event.term === 'Heat Infliction')).toBe(false);
    });
  });

  describe('her effects layer', () => {
    const at = (potential: number) => (key: string): Build => ({ ...emptyBuild(key), skills: MAXED, potential });
    const play = (team: string, script: string, potential = 0) => {
      const rotation = parseRot(`team: ${team}\n${script}`, buildAliases(bundle));
      const members = teamOf(bundle, rotation.team, rotation.steps);
      const sim = simulate(rotation.steps, members, FALLBACK_TIMINGS, {
        synergy: bundle.synergy,
        sp: { ...FALLBACK_SP, ...bundle.sp, passiveRegen: 0 },
        ultimatesCharged: true,
        modifiers: simModifiersFor(bundle, members, () => potential),
      });
      return { sim, damage: trackDamage(bundle, { frames: sim.frames, length: sim.real, team: rotation.team }, at(potential), null) };
    };
    const hit = (parts: Array<{ label: string; nonCrit: number }>, label: string) => parts.find((part) => part.label === label)!.nonCrit;
    const explosion = 'Base Explosion DMG Multiplier';
    // At Elite 4 the strongest tier is Elite 3's: the layer's value, as a fraction of RES.
    const ignored = Math.max(
      ...bundle.effects.entries
        .filter((entry) => entry.operator === 'Laevatain' && entry.source.name === 'Scorching Heart')
        .flatMap((entry) => entry.apply.filter((apply) => apply.stat === 'res_ignore').map((apply) => apply.value ?? 0)),
    );

    it('Scorching Heart: Heat RES ignored on her damage from the step after the fourth stack', () => {
      // Stacks: 1, 2, 3, 4 (the fourth battle skill), then a battle skill that spends them.
      const { damage } = play('Laevatain', 'Laevatain: BS\nLaevatain: CS\nLaevatain: FS\nLaevatain: BS\nLaevatain: BS');
      const before = hit(damage.steps[3]!.parts, explosion);
      const after = hit(damage.steps[4]!.parts, explosion);
      expect(ignored).toBeCloseTo(0.2, 9);
      expect(hit(damage.steps[0]!.parts, explosion)).toBeCloseTo(before, 6);
      expect(after / before).toBeCloseTo(1 + ignored, 6);
    });

    it("…and only on hers: a teammate's Heat hit does not get it", () => {
      const script = 'Laevatain: BS\nLaevatain: CS\nLaevatain: FS\nLaevatain: BS\nWulfgard: BS';
      const { damage } = play('Laevatain, Wulfgard', script);
      const plain = play('Laevatain, Wulfgard', 'Wulfgard: BS');
      const label = damage.steps[4]!.parts[0]!.label;
      expect(hit(damage.steps[4]!.parts, label)).toBeCloseTo(hit(plain.damage.steps[0]!.parts, label), 6);
    });

    it('P1: the extra attack ×1.2 and 20 SP back with the spending cast', () => {
      const script = 'Laevatain: BS\nLaevatain: CS\nLaevatain: FS\nLaevatain: BS\nLaevatain: BS';
      const p0 = play('Laevatain', script, 0);
      const p1 = play('Laevatain', script, 1);
      const extra = (run: typeof p0) => hit(run.damage.steps[4]!.parts, 'Additional ATK DMG Multiplier') / hit(run.damage.steps[4]!.parts, explosion);
      expect(extra(p1) / extra(p0)).toBeCloseTo(1.2, 6);
      expect(p1.sim.frames[4]!.verdicts.get('5:spReturned:Melting Flame')).toEqual({ code: 'spReturned', sp: 20, term: 'Melting Flame' });
      expect(p0.sim.frames[4]!.verdicts.has('5:spReturned:Melting Flame')).toBe(false);
    });

    it("P3: her battle skill's Combustion lasts ×1.5 and burns ×1.5 per tick", () => {
      // The fifth battle skill forces Combustion; a long pause lets it burn out.
      const script = 'Laevatain: BS\nLaevatain: CS\nLaevatain: FS\nLaevatain: BS\nLaevatain: BS\nLaevatain: WAIT 15s';
      const dot = (potential: number) => play('Laevatain', script, potential).damage.steps[4]!.parts.find((part) => part.label.startsWith('Combustion DoT'))!;
      const seconds = statAt(skillOf('Battle Skill'), 'Combustion Duration (s)', 12)!;
      // Without it, the temporary Combustion stops at its own 5 s, not at a plain Combustion's 10.
      expect(dot(2).label).toBe(`Combustion DoT × ${seconds} s`);
      expect(dot(3).label).toBe(`Combustion DoT × ${Math.floor(seconds * 1.5)} s × 1.5`);
      // P3 adds only those two multipliers to the same burn (P2's INT is already in both).
      expect(dot(3).nonCrit / dot(2).nonCrit).toBeCloseTo((Math.floor(seconds * 1.5) / seconds) * 1.5, 6);
    });

    it('P2 reaches the enhanced chain, P5 multiplies only it', () => {
      const script = 'Laevatain: FS\nLaevatain: ULT\nLaevatain: FS';
      const ratio = (potential: number) => {
        const { damage } = play('Laevatain', script, potential);
        return hit(damage.steps[2]!.parts, 'Enhanced BATK SEQ 1 Multiplier') / hit(damage.steps[0]!.parts, 'BATK SEQ 1 Multiplier');
      };
      // P2's Basic Attack DMG is on both chains: the ratio holds; P5 is the enhanced chain's alone.
      expect(ratio(2) / ratio(0)).toBeCloseTo(1, 6);
      expect(ratio(5) / ratio(4)).toBeCloseTo(1.2, 6);
    });
  });

  it("Yvonne's barrage is Basic Attack DMG too", () => {
    const rows = bundle.operators.Yvonne!.skills.find((skill) => skill.type === 'Ultimate')!.stats.filter((row) => row.hit);
    expect(rows.map((row) => row.dealtAs)).toEqual(rows.map(() => 'Basic Attack'));
  });
});
