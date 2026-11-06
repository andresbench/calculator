/**
 * Golden test: status damage and order within a cast — Pogranichnik's Breach.
 *
 * Source — `docs/measurements.md`, #23, closed 2026-10-28. Chen battle
 * skill (Lift on a clean target — one Vulnerable stack) → Pogranichnik
 * battle skill. Six numbers matched the measurement's calculation to the
 * point:
 *
 * | | SEQ 1 | Breach | SEQ 2 |
 * |---|---|---|---|
 * | AIC ×4 | 7474 | 5023 | 10 912 |
 * | AIC ×2 | 5737 | 3856 | 8376 |
 *
 * What is checked here beyond the formula:
 *
 * * SEQ 1 hits with the bare sheet;
 * * Breach already has Thermite Cutter's team +8 %: SEQ 1 consumed
 *   Vulnerable and recovered SP, and the buff came on before the Breach
 *   instance;
 * * SEQ 2 has Thermite and the Breach debuff (+12 % Physical DMG Taken at
 *   AI 0); Breach itself does not get its own debuff.
 *
 * None of the buffs is set by hand: `trackBuffs` and `statusDebuffs` issue
 * them from simulation frames.
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
  statusDamage,
  statusDebuffs,
  statusHits,
  targetSumFor,
  trackBuffs,
  type ActiveBuff,
  type BuildInput,
  type Bundle,
} from '../../src/index.js';
import { bundle, describeWithBundle, teamOf } from '../support/bundle.js';

/** Numbers from the game are integers: the screen and damage pop-ups truncate fractions. */
const TOLERANCE = 1;


describeWithBundle("Pogranichnik's Breach on the track (measurements, #23)", () => {
  const COLUMNS = { 'Will [L]': 9, 'ATK [L]': 9, 'Flow: Thermal Release': 4 };
  const FULL = ['AIC Fieldwork Hands', 'AIC Fieldwork Plate', 'AIC Fieldwork Ember', 'AIC Fieldwork Ember'];

  function run(gearNames: Array<string | null>) {
    const gear: BuildInput['gear'] = gearNames.map((name) => {
      if (!name) return null;
      const piece = bundle!.gear.pieces[name]!;
      return { piece, tier: piece.stats[0]!.values.length - 1 };
    });
    const operator = bundle!.operators['Pogranichnik']!;
    const input: BuildInput = {
      operator,
      level: 90,
      weapon: { weapon: bundle!.weapons['Thermite Cutter']!, level: 90, columns: COLUMNS },
      gear,
    };
    const ctx = { operator: 'Pogranichnik', elite: 4, potential: 2 };
    const sheetWith = (external: ActiveBuff[]) =>
      buildStatsWithEffects(input, bundle!.effects, ctx, {}, external.filter((buff) => buff.receiver !== 'Chen Qianyu'));

    const names = new Map([
      ['chen', 'Chen Qianyu'],
      ['pogranichnik', 'Pogranichnik'],
    ]);
    const rotation = parseRot('team: Chen, Pogranichnik\nChen: BS\nPogranichnik: BS', names);
    const team = teamOf(bundle!, rotation.team, rotation.steps);
    const sim = simulate(rotation.steps, team, FALLBACK_TIMINGS, { synergy: bundle!.synergy });
    const bare = sheetWith([]);
    const buffs = trackBuffs(sim.frames, [
      { key: 'Chen Qianyu', active: [] },
      { key: 'Pogranichnik', active: bare.active },
    ]);
    const debuffs = statusDebuffs(sim.frames, () => ({ artsIntensity: bare.sheet.artsIntensity }));
    const hits = statusHits(sim.frames, sim.world);

    const at = 1; // Pogranichnik's battle skill frame
    const skill = operator.skills.find((item) => item.type === 'Battle Skill')!;
    const row = (label: string) => skill.stats.find((stat) => stat.label === label)!.values[11]!;
    const hit = (external: ActiveBuff[], multiplier: number) => {
      const stats = sheetWith(external);
      return computeDamage({
        attack: stats.sheet.attack,
        baseMultiplier: multiplier,
        kind: 'skill',
        dmgBonus: dmgBonusFor(stats.sheet, { element: 'Physical', skillType: 'Battle Skill' }),
        increasedDmgTaken: targetSumFor(stats.assumed.target.dmgTaken, 'Physical'),
        def: 100,
        resistance: 1,
      }).damage;
    };

    const before = [...buffs.frames[at]!, ...debuffs.before[at]!];
    const after = [...buffs.after[at]!, ...debuffs.before[at]!];
    const breachHit = hits[at]!.find((item) => item.name === 'Breach')!;
    const breachStats = sheetWith(after);
    const breach = statusDamage(breachHit, {
      sheet: breachStats.sheet,
      target: breachStats.assumed.target,
      amp: {},
      operatorLevel: 90,
      def: 100,
      resistance: 1,
      staggered: false,
    }).damage;

    return {
      seq1: hit(before, row('SEQ 1 DMG Multiplier')),
      breach,
      seq2: hit([...after, ...debuffs.fresh[at]!], row('SEQ 2 DMG Multiplier')),
      statusLevel: breachHit.statusLevel,
    };
  }

  const near = (actual: number, game: number) =>
    expect(Math.abs(actual - game), `${actual.toFixed(1)} vs ${game}`).toBeLessThanOrEqual(TOLERANCE);

  it('AIC ×4: 7474 · 5023 · 10 912', () => {
    const result = run(FULL);
    expect(result.statusLevel).toBe(1);
    near(result.seq1, 7474);
    near(result.breach, 5023);
    near(result.seq2, 10912);
  });

  it('AIC ×2, set off: 5737 · 3856 · 8376', () => {
    const result = run([FULL[0]!, FULL[1]!, null, null]);
    near(result.seq1, 5737);
    near(result.breach, 3856);
    near(result.seq2, 8376);
  });
});
