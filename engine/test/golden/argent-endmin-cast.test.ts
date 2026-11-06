/**
 * Golden test: the Endministrator's battle skill on a target Argent Flow
 * marked, summed on the track.
 *
 * Source — `docs/measurements.md`, #59 and #61 (2026-11-05). The builds are
 * the showcase's of that day, pinned here. Argent Flow: battle skill →
 * combo → Bolt Rush; the Endministrator: combo, then her battle skill after
 * the seal had run out (Teo: «the seal expired before I pressed it»). No
 * crits. Her battle skill showed three numbers:
 *
 * | hit | game |
 * |---|---|
 * | her own hit | 33,415 |
 * | Crush SL 2 (×1.2 on Sunderization) | 160,586 |
 * | Sunderization's explosion (2 stacks) | 87,292 |
 *
 * What it pins down: the seal's +20 % DMG Taken is gone once it expires;
 * Grand Vision's +57.6 % «during the next battle skill» reaches that cast's
 * Crush too; Grizzled Edge's +12 % (2 Vulnerable consumed), fired by the
 * Crush of a one-hit cast, is already in that hit; Argent Flow's attribute
 * talent is closed (no node open), his Electrification raises every type.
 */

import { expect, it } from 'vitest';

import { buildAliases, emptyBuild, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, trackDamage, type Build, type Bundle } from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

/** Within 0.1 %: the explosion's inputs include one weapon column read off two numbers. */
const RELATIVE = 0.001;

function gearOf(bundle: Bundle, names: string[]): Build['gear'] {
  return names.map((name) => ({ key: name, tier: bundle.gear.pieces[name]!.stats[0]!.values.length - 1 }));
}

describeWithBundle('the Endministrator on a Sunderized target (measurements, #59, #61)', (bundle) => {
  const builds: Record<string, Build> = {
    'Argent Flow': {
      ...emptyBuild('Argent Flow'),
      skills: { basic: 9, battle: 10, combo: 10, ultimate: 10 },
      weaponKey: 'Lunar Calling',
      weaponColumns: { 'Will [L]': 9, 'ATK [L]': 9, 'Infliction: Coursing Stars': 4 },
      gear: gearOf(bundle, ['Pulser Labs Light Gauntlets', 'Pulser Labs Light Armor', 'Pulser Labs Armor Slab', 'Pulser Labs Armor Slab']),
      talentNodes: { attribute: 0, passive: [2, 2] },
    },
    'Endministrator (female)': {
      ...emptyBuild('Endministrator (female)'),
      potential: 4,
      skills: { basic: 12, battle: 12, combo: 12, ultimate: 12 },
      weaponKey: 'Grand Vision',
      weaponColumns: { 'Agility [L]': 9, 'ATK [L]': 9, 'Infliction: Long Time Wish': 4 },
      gear: gearOf(bundle, [
        'Grizzled Edge Gauntlets T1',
        'Swordmancer Heavy Armor T1',
        'Grizzled Edge Push Knife T1',
        'Grizzled Edge Push Knife T1',
      ]),
      talentNodes: { attribute: 4, passive: [2, 2] },
    },
  };
  const rotation = parseRot(
    'team: Argent Flow, Endministrator\nArgent Flow: BS\nArgent Flow: CS\nArgent Flow: BS\nEndministrator: CS\nEndministrator: WAIT 6s\nEndministrator: BS',
    buildAliases(bundle),
  );
  const team = teamOf(bundle, rotation.team, rotation.steps);
  const sim = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, { sp: bundle.sp ?? FALLBACK_SP, synergy: bundle.synergy });
  const damage = trackDamage(
    bundle,
    { frames: sim.frames, length: sim.real, team: [...team.keys()] },
    (key) => builds[key] ?? emptyBuild(key),
    null,
  );
  const parts = damage.steps[sim.frames.length - 1]!.parts;
  const near = (label: RegExp, game: number) => {
    const part = parts.find((item) => label.test(item.label));
    expect(part, `no part ${label}`).toBeDefined();
    expect(Math.abs(part!.nonCrit / game - 1), `${part!.nonCrit.toFixed(0)} vs ${game}`).toBeLessThanOrEqual(RELATIVE);
  };

  it('her own hit', () => near(/^DMG Multiplier/, 33415));
  it('Crush SL 2 on the mark', () => near(/^Crush SL 2/, 160586));
  it('the explosion of two Sunderization stacks', () => near(/^Sunderization/, 87292));
});
