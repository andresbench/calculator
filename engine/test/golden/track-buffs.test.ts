/**
 * Golden test: buffs on the track trigger from rotation events.
 *
 * Source — `docs/measurements.md`, #4, run F3 (2026-10-28), a clean Rossi:
 * no gear, `Aspirant` lv. 1, ATK 911, Physical +4.4 %. The SEQ 2 of her
 * combo is a bare 3.0 × ATK (n = 0), and the extra multipliers are
 * Camille's team buffs, in one group with Physical DMG:
 *
 * * `Beacon of Duty` — after Heat Susceptibility, team Physical +8 %
 *   (column 6 of 9);
 * * set `Frontiers` — a skill recovered SP (Camille's combo) → team +16 %.
 *
 * | run | what is up | SEQ 2 |
 * |---|---|---|
 * | Combustion: Perlica battle → Camille battle → Rossi combo | Beacon | 1537 |
 * | Electrification: Camille battle → Camille combo → Perlica battle → Rossi combo | Beacon + Frontiers | 1755 |
 *
 * Nothing is set by hand except the builds from the screens: which buffs
 * are up at Rossi's step is decided by `trackBuffs` from simulation frames.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  activeEffects,
  buildStatsWithEffects,
  computeDamage,
  dmgBonusFor,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  targetSumFor,
  trackBuffs,
  type Bundle,
} from '../../src/index.js';
import { bundle, describeWithBundle, teamOf } from '../support/bundle.js';

/** The screen truncates fractions. */
const TOLERANCE = 1;


describeWithBundle('buffs on the track — Rossi F3 (measurements, #4)', () => {
  const names = new Map([
    ['perlica', 'Perlica'],
    ['camille', 'Camille'],
    ['rossi', 'Rossi'],
  ]);
  /** Camille: Beacon of Duty with the named effect in column 6, three Frontiers pieces. */
  const camille = activeEffects(bundle!.effects, {
    operator: 'Camille',
    elite: 4,
    potential: 0,
    weapon: { name: 'Beacon of Duty', columns: { 'Efficacy: Fuel for the Torch': 6 } },
    sets: { Frontiers: 3 },
  });
  const rossiCtx = {
    operator: 'Rossi',
    elite: 4,
    potential: 0,
    weapon: {
      name: 'Aspirant',
      columns: { 'Agility [M]': 1, 'Physical DMG [M]': 1, 'Twilight: Imposing Peak': 1 },
    },
    sets: {},
  };

  function seq2(script: string): { damage: number; buffs: string[] } {
    const rotation = parseRot(`team: Perlica, Camille, Rossi\n${script}`, names);
    const team = teamOf(bundle!, rotation.team, rotation.steps);
    const sim = simulate(rotation.steps, team, FALLBACK_TIMINGS, { synergy: bundle!.synergy });
    const buffs = trackBuffs(sim.frames, [
      { key: 'Perlica', active: [] },
      { key: 'Camille', active: camille },
      { key: 'Rossi', active: activeEffects(bundle!.effects, rossiCtx) },
    ]);
    const index = sim.frames.findIndex((frame) => frame.step.actor === 'Rossi' && frame.step.sequence === 2);
    const external = buffs.frames[index]!.filter((buff) => buff.receiver === 'Rossi' || buff.receiver === 'enemy');

    const operator = bundle!.operators['Rossi']!;
    const stats = buildStatsWithEffects(
      { operator, level: 90, weapon: { weapon: bundle!.weapons['Aspirant']!, level: 1, columns: rossiCtx.weapon.columns }, gear: [] },
      bundle!.effects,
      rossiCtx,
      {},
      external,
    );
    const combo = operator.skills.find((skill) => skill.type === 'Combo Skill')!;
    const multiplier = combo.stats.find((row) => row.label === 'SEQ 2 DMG Multiplier')!.values[11]!;
    const damage = computeDamage({
      attack: stats.sheet.attack,
      baseMultiplier: multiplier,
      kind: 'skill',
      dmgBonus: dmgBonusFor(stats.sheet, { element: 'Physical', skillType: 'Combo Skill' }),
      increasedDmgTaken: targetSumFor(stats.assumed.target.dmgTaken, 'Physical'),
      susceptibility: targetSumFor(stats.assumed.target.susceptibility, 'Physical'),
      def: 100,
      resistance: 1,
    }).damage;
    return { damage, buffs: external.map((buff) => buff.effect.id) };
  }

  it('Combustion: Beacon of Duty after Camille\'s Heat Susceptibility — 1537', () => {
    const { damage, buffs } = seq2('Perlica: BS\nCamille: BS\nRossi: CS1 > CS2');
    expect(buffs).toContain('weapon.beacon-of-duty.efficacy-fuel-for-the-torch');
    expect(Math.abs(damage - 1537)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('Electrification after Camille\'s combo: Beacon and Frontiers — 1755', () => {
    const { damage, buffs } = seq2('Camille: BS > CS\nPerlica: BS\nRossi: CS1 > CS2');
    expect(buffs).toContain('gear-set.frontiers.frontiers');
    expect(Math.abs(damage - 1755)).toBeLessThanOrEqual(TOLERANCE);
  });
});
