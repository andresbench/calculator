/**
 * Effects filtered by one skill or conditioned on the target (audit
 * 2026-11-12, В14, В15).
 *
 * * Estella's P3 «Battle skill Onomatopoeia improved: … DMG Dealt +40%» —
 *   `dmg_bonus` with `skill`: her battle skill only, not the basic attack,
 *   the combo or the ultimate.
 * * Mi Fu's Stern Crackdown «×1.2 … against targets with Physical
 *   Susceptibility or Staggered» — `targetHas` on a skill multiplier: the
 *   track passes what stands on the target (`DummyState.targetTerms`).
 * * Xaihi's Execute Process «DMG Taken … to targets with Cryo Infliction or
 *   Solidification» — `targetHas` on a buff row: it fires only when the
 *   target the step met has one.
 */

import { expect, it } from 'vitest';

import {
  activeEffects,
  analyse,
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  trackBuffs,
  type Build,
  type Bundle,
  type DummyState,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('effects on one skill or on a target condition', (bundle: Bundle) => {
  const maxed = (key: string, potential = 0): Build => ({ ...emptyBuild(key), potential, skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 } });
  const dummy: DummyState = { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} };

  it("Estella's P3 raises Onomatopoeia alone", () => {
    const rows = (potential: number) => analyse(maxed('Estella', potential), bundle, dummy)!.skills;
    const p2 = rows(2);
    const p3 = rows(3);
    expect(p3.length).toBe(p2.length);
    for (const [index, row] of p3.entries()) {
      const ratio = row.result.damage / p2[index]!.result.damage;
      expect(ratio).toBeCloseTo(row.type === 'Battle Skill' ? 1.4 : 1, 9);
    }
    expect(p3.some((row) => row.type === 'Battle Skill')).toBe(true);
  });

  it("Mi Fu's Stern Crackdown fires on Physical Susceptibility as on Staggered", () => {
    const splitter = (state: Partial<DummyState>) =>
      analyse(maxed('Mi Fu'), bundle, { ...dummy, ...state })!.skills.find((row) => row.label.startsWith('World Splitter'))!;
    expect(splitter({}).skillMultiplier).toBe(1);
    expect(splitter({ targetTerms: ['Heat Susceptibility'] }).skillMultiplier).toBe(1);
    expect(splitter({ targetTerms: ['Physical Susceptibility'] }).skillMultiplier).toBe(1.2);
    expect(splitter({ targetTerms: ['Physical Susceptibility'] }).multiplierFrom.map((item) => item.source)).toEqual(['Stern Crackdown']);
    expect(splitter({ staggered: true }).skillMultiplier).toBe(1.2);
  });

  it("Xaihi's Execute Process waits for Cryo Infliction or Solidification on the target", () => {
    const play = (script: string) => {
      const rotation = parseRot(script, buildAliases(bundle));
      const team = teamOf(bundle, rotation.team, rotation.steps);
      const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
        synergy: bundle.synergy,
        sp: { ...(bundle.sp ?? FALLBACK_SP), passiveRegen: 1000 },
        ultimatesCharged: true,
      });
      const holders = [...team.keys()].map((key) => ({ key, active: activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0 }) }));
      const timeline = trackBuffs(frames, holders);
      const fired = timeline.after.map((list) => list.some((buff) => buff.effect.source.name === 'Execute Process' && buff.apply.stat === 'dmg_taken'));
      return { frames, fired };
    };
    // Chen puts up Physical statuses only: the target Xaihi's combo meets has
    // no Cryo, and the combo's own Cryo Infliction comes after the check.
    const cold = play('team: Xaihi, Chen Qianyu\nChen Qianyu: BS\nXaihi: CS');
    expect(cold.frames[0]!.target.inflictions.Cryo).toBe(0);
    expect(cold.fired).toEqual([false, false]);
    // Her second combo meets the Cryo Infliction her first one applied.
    const warm = play('team: Xaihi, Chen Qianyu\nChen Qianyu: BS\nXaihi: CS\nXaihi: CS');
    expect(warm.frames[1]!.target.inflictions.Cryo).toBeGreaterThan(0);
    expect(warm.fired).toEqual([false, false, true]);
  });
});
