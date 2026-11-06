/**
 * Golden test: Chen's battle skill on a fresh boss, with her showcase build.
 *
 * Source — `docs/measurements.md`, #60 (2026-11-05). Stat screen before the
 * fight: ATK 4582, Physical +37.9 %, Battle Skill DMG +44.9 %, crit 24.5 %.
 * Her battle skill on a fresh Rhodagn: one number, 17,502 (no crit) — the
 * Lift became Vulnerable, so Swordmancer added no hit. The ATK holds only
 * with Glorious Memory's ATK +16.8 % (column 8).
 *
 * Her second battle skill on the same boss (one Vulnerable standing):
 * 18,701 (the skill), 6,308 (Lift), 8,440 (Swordmancer's hit), no crits.
 * The hit is a plain 2.5 × ATK with Physical DMG only — no hidden level
 * multiplier, no Arts Intensity, no battle-skill bonus — and the cast's
 * statuses use her ATK before the talent stack this cast adds.
 */

import { expect, it } from 'vitest';

import {
  analyse,
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  trackDamage,
  type Build,
  type Bundle,
} from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

function gearOf(bundle: Bundle, names: Array<string>): Build['gear'] {
  return names.map((name) => ({ key: name, tier: bundle.gear.pieces[name]!.stats[0]!.values.length - 1 }));
}

describeWithBundle("Chen's battle skill with her showcase build (measurements, #60)", (bundle) => {
  const build: Build = {
    ...emptyBuild('Chen Qianyu'),
    potential: 5,
    skills: { basic: 11, battle: 12, combo: 12, ultimate: 12 },
    weaponKey: 'Glorious Memory',
    weaponColumns: { 'Agility [L]': 9, 'Critical Rate [L]': 9, 'Twilight: Lingering Glow': 8 },
    gear: gearOf(bundle, ['MI Security Gloves', 'Swordmancer Heavy Armor', 'Swordmancer Dagger', 'Swordmancer Flint']),
    talentNodes: { attribute: 4, passive: [2, 2] },
  };
  const analysis = analyse(build, bundle, { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} })!;

  it('the stat screen', () => {
    expect(Math.abs(analysis.sheet.attack - 4582)).toBeLessThanOrEqual(1);
    expect(analysis.sheet.critRate).toBeCloseTo(0.245, 3);
  });

  it('the battle skill hit', () => {
    const hit = analysis.skills.find((row) => row.id === 'Battle Skill::DMG Multiplier')!.result.damage;
    expect(Math.abs(hit / 17502 - 1)).toBeLessThanOrEqual(0.001);
  });

  it('her second battle skill: the skill, Lift and the Swordmancer hit', () => {
    const rotation = parseRot('Chen Qianyu: BS\nChen Qianyu: WAIT 3s\nChen Qianyu: BS', buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const sim = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, { sp: bundle.sp ?? FALLBACK_SP, synergy: bundle.synergy });
    const damage = trackDamage(bundle, { frames: sim.frames, length: sim.real, team: [...team.keys()] }, () => build, null);
    const parts = damage.steps[2]!.parts;
    const near = (label: string, game: number) => {
      const part = parts.find((item) => item.label === label);
      expect(Math.abs(part!.nonCrit / game - 1), `${label}: ${part?.nonCrit.toFixed(0)} vs ${game}`).toBeLessThanOrEqual(0.001);
    };
    near('DMG Multiplier', 18701);
    near('Lift', 6308);
    near('Swordmancer hit', 8440);
  });
});
