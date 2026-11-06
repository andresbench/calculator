/**
 * Golden test: Lifeng's Illumination sits in AttributeBonus, and the stat
 * screen does not show it.
 *
 * Source — `docs/measurements.md`, #36, closed 2026-10-28. The build from
 * the screen: `Valiant` lv. 90 (Agility +156, Physical DMG Dealt +36.7 %,
 * ATK +16 %), three Eternal Xiranite pieces and `Bonekrusha Poncho T1`. The
 * stat screen shows ATK **3656**, unchanged in combat: that is the formula
 * without the talent. Hits of the basic attack chain (lv. 6), non-crit, a
 * fresh dummy:
 *
 * | hit   | game          | no talent   | talent in AttributeBonus | talent as ATK %  |
 * |-------|---------------|-------------|-------------------------|------------------|
 * | SEQ 1 | 538 + 538     | 899         | 1076                    | 1494             |
 * | SEQ 2 | 1315          | 1099        | 1315                    | 1826             |
 * | SEQ 3 | 1584          | 1324        | 1584                    | 2199             |
 * | SEQ 4 | 777 + 2242    | 2523        | 3019                    | 4192             |
 *
 * The roster's weapon is out of date (the showcase had `Beacon of Duty`), so
 * it is set here explicitly: `Valiant` with Chen's essence, columns 9/8/4
 * from the weapon screen (measurements, #6). The effects layer supplies the
 * numbers.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildStatsWithEffects,
  computeDamage,
  type BuildInput,
  type Bundle,
} from '../../src/index.js';
import { bundle, describeWithBundle } from '../support/bundle.js';

/** From the stat screen, 2026-10-28. */
const SCREEN_ATK = 3656;
/** Hits by sequence; SEQ 1 and SEQ 4 show two numbers each — summed. */
const HITS = { 1: 538 + 538, 2: 1315, 3: 1584, 4: 777 + 2242 } as const;
/** Tolerance: the screen truncates the fraction of each number. */
const TOLERANCE = 1.5;


describeWithBundle("Lifeng's Illumination — AttributeBonus, not on screen (measurements, #36)", () => {
  const operator = bundle!.operators['Lifeng']!;
  const weapon = bundle!.weapons['Valiant']!;
  // Gear on the measurement day, written out explicitly: the roster is a
  // showcase snapshot and changes with every import.
  const gear: BuildInput['gear'] = [
    'Eternal Xiranite Hands',
    'Bonekrusha Poncho T1',
    'Eternal Xiranite Bracing Slab T1',
    'Eternal Xiranite Bracing Slab T1',
  ].map((name) => {
    const piece = bundle!.gear.pieces[name]!;
    return { piece, tier: piece.stats[0]!.values.length - 1 };
  });
  const columns = { 'Agility [L]': 9, 'Physical DMG [L]': 8, 'Combative: Virtuous Gain': 4 };

  // The screen is the same sheet minus Illumination alone: Skirmisher (AGL +60) is on it.
  const withoutIllumination = {
    ...bundle!.effects,
    entries: bundle!.effects.entries.filter((effect) => !(effect.operator === 'Lifeng' && effect.source.name === 'Illumination')),
  };
  const sheet = (illumination: boolean) =>
    buildStatsWithEffects(
      { operator, level: 90, weapon: { weapon, level: 90, columns }, gear },
      illumination ? bundle!.effects : withoutIllumination,
      { operator: 'Lifeng', elite: 4, potential: 0 },
    ).sheet;

  const chain = bundle!.operators['Lifeng']!.skills.find((skill) => skill.type === 'Basic Attack')!;
  const hit = (attack: number, seq: 1 | 2 | 3 | 4) =>
    computeDamage({
      attack,
      baseMultiplier: chain.stats.find((row) => row.label === `BATK SEQ ${seq} Multiplier`)!.values[5]!,
      kind: 'skill',
      dmgBonus: 0.3667,
      def: 100,
      resistance: 1,
    }).damage;

  it('the stat screen is the sheet without the talent, but with Skirmisher', () => {
    expect(Math.abs(sheet(false).attack - SCREEN_ATK)).toBeLessThan(TOLERANCE);
  });

  it.each([1, 2, 3, 4] as const)('SEQ %i hits with ATK that has the talent in AttributeBonus', (seq) => {
    const attack = sheet(true).attack;
    expect(Math.abs(hit(attack, seq) - HITS[seq])).toBeLessThan(TOLERANCE);
  });
});
