/**
 * The effects layer: enabling by elite, combining tiers, two passes.
 *
 * The numbers here are not written from memory. Each one is in the wiki
 * text stored in `seen` next to the parse, and `tools/ef/effects.py` checks
 * `seen` against the current text in `operators.json` and flags drift as
 * `stale`. So "+25 AGL at Elite 2" rests on two guards: this test and that
 * check. A separate test below requires that no record is `stale` —
 * otherwise this file's claims belong to the previous patch.
 *
 * The bundle is generated and not versioned: without it the test is skipped
 * rather than inventing a pass. To build: `python3 tools/ef/export.py`.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  actionsFor,
  activeEffects,
  buildStatsWithEffects,
  effectModifiers,
  operatorAttribute,
  parseRot,
  targetSumFor,
  skillMultiplierFor,
  type Bundle,
} from '../src/index.js';
import { bundle, describeWithBundle } from './support/bundle.js';


const LEVEL = 80;

function statsFor(
  key: string,
  elite: number,
  potential: number,
  assume: Record<string, number> = {},
) {
  const operator = bundle!.operators[key];
  if (!operator) throw new Error(`no operator ${key}`);
  return buildStatsWithEffects(
    { operator, level: LEVEL },
    bundle!.effects,
    { operator: key, elite, potential },
    assume,
  );
}

function idOf(key: string, elite: number, potential: number, talent: string): string {
  const active = activeEffects(bundle!.effects, { operator: key, elite, potential });
  const effect = active.find((entry) => entry.source.name === talent);
  if (!effect) throw new Error(`no effect ${talent} on ${key}`);
  return effect.id;
}

describeWithBundle('effects layer', () => {
  it('the bundle has parsed operators', () => {
    expect(bundle!.effects.covered.length).toBeGreaterThan(0);
    expect(bundle!.effects.entries.length).toBeGreaterThan(0);
  });

  it('no record has drifted from the wiki text', () => {
    const stale = bundle!.effects.entries.filter((entry) => entry.stale);
    expect(stale.map((entry) => entry.id)).toEqual([]);
  });

  it('every record with a placement has wiki text and seen', () => {
    for (const entry of bundle!.effects.entries) {
      if (entry.apply.length === 0) continue;
      expect(entry.text, entry.id).toBeTruthy();
      expect(entry.seen, entry.id).toBeTruthy();
    }
  });

  it('percentages are converted to fractions, flat values left as is', () => {
    for (const entry of bundle!.effects.entries) {
      for (const apply of entry.apply) {
        // For weapons the number is a table by column; every column is checked.
        if (apply.values) {
          const scale = apply.unit === 'frac' ? 100 : 1;
          apply.values.forEach((value, index) =>
            expect(value, `${entry.id}/${apply.stat}`).toBeCloseTo(apply.rawValues![index]! / scale, 10),
          );
          continue;
        }
        if (apply.rawValue == null) throw new Error(`${entry.id}: neither value nor values`);
        if (apply.unit === 'frac') {
          expect(apply.value, `${entry.id}/${apply.stat}`).toBeCloseTo(apply.rawValue / 100, 10);
        } else {
          expect(apply.value, `${entry.id}/${apply.stat}`).toBe(apply.rawValue);
        }
      }
    }
  });
});

describeWithBundle('enabling by elite and potential', () => {
  it('nothing is enabled at Elite 0 without potential', () => {
    const active = activeEffects(bundle!.effects, { operator: 'Chen Qianyu', elite: 0, potential: 0 });
    expect(active.filter((entry) => entry.requires.elite! > 0)).toEqual([]);
  });

  it("an attribute talent's tiers add up", () => {
    // Skirmisher: +10 at Elite 1 and +15 at Elite 2. Measurements #22:
    // attribute talents add up, checked on the stat screen.
    const base = operatorAttribute(bundle!.operators['Chen Qianyu']!, 'AGL', LEVEL)!;
    expect(statsFor('Chen Qianyu', 1, 0).sheet.attributes.AGL).toBeCloseTo(base + 10, 3);
    expect(statsFor('Chen Qianyu', 2, 0).sheet.attributes.AGL).toBeCloseTo(base + 25, 3);
    expect(statsFor('Chen Qianyu', 4, 0).sheet.attributes.AGL).toBeCloseTo(base + 60, 3);
  });

  it("a replacing talent's tiers take the highest", () => {
    // For tiered talents the game draws a selector and ticks the strongest
    // available tier itself (measurements, #22).
    const active = activeEffects(bundle!.effects, { operator: 'Chen Qianyu', elite: 4, potential: 0 });
    const tiers = active
      .filter((entry) => entry.source.name === 'Slashing Edge')
      .map((entry) => entry.tier);
    expect(tiers).toEqual([2]);
  });

  it('a potential adds exactly what the text says', () => {
    // "Agility +15, Physical DMG Dealt +8%" — Chen's second potential.
    const withoutPotential = statsFor('Chen Qianyu', 4, 1);
    const withPotential = statsFor('Chen Qianyu', 4, 2);
    expect(withPotential.sheet.attributes.AGL - withoutPotential.sheet.attributes.AGL).toBeCloseTo(15, 3);
    expect(withPotential.sheet.dmgBonus.byElement.Physical).toBeCloseTo(0.08, 6);
    expect(withoutPotential.sheet.dmgBonus.byElement.Physical ?? 0).toBe(0);
  });
});

describeWithBundle('triggered effects stay out of the stat sheet', () => {
  it('Slashing Edge is dynamic, not a stat', () => {
    const chen = statsFor('Chen Qianyu', 2, 0);
    // The talent gives ATK +8 % per skill hit, up to five stacks. That is
    // track state, not a stat: showing it as a bonus without a track would
    // inflate the bare sheet.
    expect(chen.sheet.attackPercent).toBe(0);
    const dynamic = chen.dynamic.filter(({ effect }) => effect.source.name === 'Slashing Edge');
    expect(dynamic).toHaveLength(1);
    expect(dynamic[0]!.apply.stacks).toEqual({ max: 5, perTrigger: 1 });
    expect(dynamic[0]!.apply.duration).toBe(10);
    expect(dynamic[0]!.apply.rawValue).toBe(8);
  });
});

describeWithBundle('Illumination: a point coefficient in AttributeBonus', () => {
  // Datamine: the talent adds to AtkIncreaseFactorFromWisd/Will, not to
  // ATK %. Lifeng's main is AGL and secondary STR, so INT and WIL enter
  // AttributeBonus only through this talent.
  const bonus = (sheet: { attributes: Partial<Record<string, number>> }, factor: number) => {
    const [AGL, STR, INT, WIL] = (['AGL', 'STR', 'INT', 'WIL'] as const).map((key) => Math.floor(sheet.attributes[key] ?? 0));
    return 1 + 0.005 * AGL! + 0.002 * STR! + factor * (INT! + WIL!);
  };

  it('Elite 2 gives +0.15 % per point of INT and WIL', () => {
    const lifeng = statsFor('Lifeng', 2, 0);
    expect(lifeng.sheet.attackPercent).toBeCloseTo(0, 8);
    expect(lifeng.sheet.attributeBonus).toBeCloseTo(bonus(lifeng.sheet, 0.0015), 8);
  });

  it('potential 3 adds another +0.05 % to the same coefficient', () => {
    const withP3 = statsFor('Lifeng', 2, 3);
    expect(withP3.sheet.attributeBonus).toBeCloseTo(bonus(withP3.sheet, 0.002), 8);
  });

  it("potential 2's flat bonuses are already inside the attributes", () => {
    // "All attributes +15" must reach INT and WIL before AttributeBonus.
    const withP2 = statsFor('Lifeng', 2, 2);
    const without = statsFor('Lifeng', 2, 0);
    expect(withP2.sheet.attributes.INT - without.sheet.attributes.INT).toBeCloseTo(15, 8);
    expect(withP2.sheet.attributeBonus).toBeCloseTo(bonus(withP2.sheet, 0.0015), 8);
  });
});

describeWithBundle('skill multipliers', () => {
  it('multiply and respect the target condition', () => {
    // Mi Fu's P5 text says outright: the bonus stacks with the talent Stern
    // Crackdown, which requires Physical Susceptibility or a stun.
    const mifu = statsFor('Mi Fu', 4, 5);
    const clean = skillMultiplierFor(mifu.modifiers, { skill: 'World Splitter' });
    const onSusceptible = skillMultiplierFor(mifu.modifiers, {
      skill: 'World Splitter',
      targetTerms: ['Physical Susceptibility'],
    });
    expect(clean.value).toBeCloseTo(1.1, 6);
    expect(onSusceptible.value).toBeCloseTo(1.32, 6);
    expect(onSusceptible.from).toHaveLength(2);
  });

  it('recognise a move within a skill by its stat label', () => {
    // "World Splitter" is the third move of Mi Fu's battle skill `Qingbo
    // Triplex`, and on the wiki it exists only as a stat label prefix.
    const mifu = statsFor('Mi Fu', 4, 5);
    const move = skillMultiplierFor(mifu.modifiers, {
      skill: 'Qingbo Triplex',
      instanceLabel: 'World Splitter DMG Multiplier',
      targetTerms: ['Staggered'],
    });
    expect(move.value).toBeCloseTo(1.32, 6);
    const other = skillMultiplierFor(mifu.modifiers, {
      skill: 'Qingbo Triplex',
      instanceLabel: 'SP Cost',
    });
    expect(other.value).toBe(1);
  });

  it('one record does not fire twice on an instance', () => {
    // Camille's third potential raises both the combo `Heartstake Thorn` and
    // the move inside it, `Hunter Pursuit` — each up to ×1.3. On the move's
    // row that is one 1.3 multiplier, not 1.3 × 1.3.
    const camille = statsFor('Camille', 4, 3);
    const move = skillMultiplierFor(camille.modifiers, {
      skill: 'Heartstake Thorn',
      instanceLabel: 'Hunter Pursuit DMG Multiplier',
    });
    expect(move.value).toBeCloseTo(1.3, 6);
    expect(move.from).toHaveLength(1);
    const base = skillMultiplierFor(camille.modifiers, {
      skill: 'Heartstake Thorn',
      instanceLabel: 'DMG Multiplier',
    });
    expect(base.value).toBeCloseTo(1.3, 6);
  });

  it("do not touch other operators' skills", () => {
    const chen = statsFor('Chen Qianyu', 4, 3);
    expect(skillMultiplierFor(chen.modifiers, { skill: 'Blade Gale' }).value).toBeCloseTo(1.1, 6);
    expect(skillMultiplierFor(chen.modifiers, { skill: 'Soaring Break' }).value).toBe(1);
  });

  it('ultimate cost and combo cooldown arrive as modifiers, not stats', () => {
    const chen = statsFor('Chen Qianyu', 4, 5);
    expect(chen.modifiers.ultCostPct).toBeCloseTo(-0.15, 6);
    expect(chen.modifiers.cooldownFlat['Combo Skill']).toBe(-3);
  });

  it('effectModifiers invents nothing on an empty list', () => {
    const empty = effectModifiers([]);
    expect(empty.skillMultipliers).toEqual([]);
    expect(empty.ultCostPct).toBe(0);
    expect(skillMultiplierFor(empty, { skill: 'Blade Gale' }).value).toBe(1);
  });
});

describeWithBundle('what the vocabulary cannot express is visible, not lost', () => {
  it("Chen's shield and cast interrupt are unmodeled", () => {
    const chen = statsFor('Chen Qianyu', 4, 5);
    expect(chen.unmodeled.length).toBeGreaterThan(0);
    for (const effect of chen.unmodeled) {
      expect(effect.unmodeled, effect.id).toBeTruthy();
    }
  });

  it('a partial parse is visible from both sides', () => {
    // Rossi's fifth potential gives an ultimate multiplier and +30 % crit
    // damage. The first is parsed, the second is not, and the record must be
    // on both lists, or "not modelled" would look like "not parsed at all".
    const rossi = statsFor('Rossi', 4, 5);
    const both = rossi.unmodeled.filter((effect) => effect.apply.length > 0);
    expect(both.length).toBeGreaterThan(0);
  });

  it('Endministrator is parsed onto both wiki keys', () => {
    // The wiki has two operators, male and female; in the data only gender
    // and the internal id differ, so there is one parse and two keys.
    for (const key of ['Endministrator (female)', 'Endministrator (male)']) {
      expect(bundle!.effects.covered, key).toContain(key);
      const active = activeEffects(bundle!.effects, { operator: key, elite: 3, potential: 1 });
      const stasis = active.find((effect) => effect.source.name === 'Realspace Stasis');
      // Measurements #10: exactly +20 % Physical DMG Taken on a sealed target.
      expect(stasis?.apply[0]?.rawValue, key).toBe(20);
      expect(stasis?.confidence, key).toBe('confirmed');
    }
  });
});

describeWithBundle('the stack assumption', () => {
  it('without the assumption a triggered effect takes no part in the numbers', () => {
    const chen = statsFor('Chen Qianyu', 2, 0);
    expect(chen.sheet.attackPercent).toBe(0);
    expect(chen.assumed.applied).toEqual([]);
  });

  it('stacks add up to the cap and no further', () => {
    // Slashing Edge: ATK +8 % per stack, cap five.
    const id = idOf('Chen Qianyu', 2, 0, 'Slashing Edge');
    expect(statsFor('Chen Qianyu', 2, 0, { [id]: 1 }).sheet.attackPercent).toBeCloseTo(0.08, 8);
    expect(statsFor('Chen Qianyu', 2, 0, { [id]: 5 }).sheet.attackPercent).toBeCloseTo(0.4, 8);
    // The game gives no sixth stack, and the assumption must not let one in.
    expect(statsFor('Chen Qianyu', 2, 0, { [id]: 9 }).sheet.attackPercent).toBeCloseTo(0.4, 8);
  });

  it("an effect on the target goes into the target's groups, not the stat sheet", () => {
    // Realspace Stasis: Physical DMG Taken +20 % on a sealed target.
    const key = 'Endministrator (female)';
    const id = idOf(key, 3, 0, 'Realspace Stasis');
    const endmin = statsFor(key, 3, 0, { [id]: 1 });
    expect(endmin.sheet.attackPercent).toBe(0);
    expect(targetSumFor(endmin.assumed.target.dmgTaken, 'Physical')).toBeCloseTo(0.2, 8);
    // The element filter is mandatory: it does not apply to an arts instance.
    expect(targetSumFor(endmin.assumed.target.dmgTaken, 'Cryo')).toBe(0);
  });

  it("Endministrator's ATK buff gives exactly the 30 % in the text", () => {
    // Measurements #8: on the real build these 30 % gave ×1.204, because
    // percentages add up in one group. Here the operator is bare, so the
    // group has a single term and shows directly.
    const key = 'Endministrator (female)';
    const id = idOf(key, 2, 0, 'Essence Disintegration');
    expect(statsFor(key, 2, 0, { [id]: 1 }).sheet.attackPercent).toBeCloseTo(0.3, 8);
  });

  it('one effect — one stack counter for all its rows', () => {
    // Pogranichnik's Fervent Morale is ATK and Arts Intensity in one record.
    const id = idOf('Pogranichnik', 2, 0, 'The Living Banner');
    const pogran = statsFor('Pogranichnik', 2, 0, { [id]: 3 });
    expect(pogran.sheet.attackPercent).toBeCloseTo(0.24, 8);
    expect(pogran.sheet.artsIntensity).toBeCloseTo(24, 8);
  });
});

describeWithBundle('action palette', () => {
  it('stages come from the data, not from memory', () => {
    // Mi Fu: the three-stage battle skill shows up as the `sequences` array
    // in the "SP Cost" row (100 / 50 / 50), and the wiki names all three moves.
    const mifu = actionsFor(bundle!.operators['Mi Fu']!);
    const battle = mifu.filter((option) => option.kind === 'BS');
    expect(battle.map((option) => option.token)).toEqual(['BS1', 'BS2', 'BS3']);
    expect(battle[2]!.name).toContain('World Splitter');

    // Lifeng: `SEQ 1/2/3` rows too, but one press that swings three times —
    // nothing splits the cost by stage. Same for Pogranichnik, whose combo
    // slashes as many times as the stacks it consumed.
    const lifeng = actionsFor(bundle!.operators.Lifeng!);
    expect(lifeng.filter((option) => option.kind === 'BS').map((o) => o.token)).toEqual(['BS']);
    const pog = actionsFor(bundle!.operators.Pogranichnik!);
    expect(pog.filter((option) => option.kind !== 'BA').map((o) => o.token)).toEqual(
      expect.arrayContaining(['BS', 'CS', 'ULT']),
    );
    expect(pog.some((option) => option.sequence != null)).toBe(false);

    // Rossi's combo is two presses: the cooldown row is split by stage.
    const rossi = actionsFor(bundle!.operators.Rossi!);
    expect(rossi.filter((option) => option.kind === 'CS').map((o) => o.token)).toEqual(['CS1', 'CS2']);

    // Chen: a single-stage battle skill, there must be no number.
    const chen = actionsFor(bundle!.operators['Chen Qianyu']!);
    expect(chen.filter((option) => option.kind === 'BS').map((o) => o.token)).toEqual(['BS']);
  });

  it('"per SEQ" does not turn into an invented number', () => {
    // Akekuri's combo is described as "DMG Multiplier per SEQ": there are
    // stages, but the data does not say how many.
    const akekuri = actionsFor(bundle!.operators.Akekuri!);
    expect(akekuri.filter((option) => option.kind === 'CS').map((o) => o.token)).toEqual(['CS']);
  });

  it('finisher and dive are offered only to those who have them', () => {
    for (const operator of Object.values(bundle!.operators)) {
      const options = actionsFor(operator);
      const basic = operator.skills.find((skill) => skill.type === 'Basic Attack');
      const hasFinisher = Boolean(
        basic?.stats.some((row) => /Finisher ATK Multiplier/i.test(row.label)),
      );
      expect(options.some((option) => option.kind === 'FIN'), operator.key).toBe(hasFinisher);
    }
  });

  it('every palette action has a parseable token', () => {
    const aliases = new Map([['chen', 'Chen Qianyu']]);
    for (const operator of Object.values(bundle!.operators)) {
      for (const option of actionsFor(operator)) {
        const parsed = parseRot(`chen: ${option.token}`, aliases);
        expect(parsed.steps, `${operator.key} ${option.token}`).toHaveLength(1);
        expect(parsed.steps[0]!.kind).toBe(option.kind);
        expect(parsed.steps[0]!.sequence).toBe(option.sequence);
      }
    }
  });
});
