/**
 * Arts Intensity on the track: a buff that raises it, and the status debuffs
 * that scale with it.
 *
 * The case is real: Arcane in Deep Rampart. A Nature stack on top of a
 * standing one is a Nature Burst, the set answers with Arts Intensity +16,
 * and Corrosion's shred is × (3·AI + 300) / (AI + 300) of its applier
 * (measurements, #39) — as the applier stood at the step that applied it
 * (#46).
 */

import { expect, it } from 'vitest';

import {
  activeEffects,
  analyse,
  corrosionShred,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  trackBuffs,
  trackDamage,
  type Build,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('Arts Intensity on the track', (bundle) => {
  const arcane = activeEffects(bundle.effects, { operator: 'Arcane', elite: 4, potential: 0, sets: { 'Deep Rampart': 3 } });
  const play = (script: string) => {
    const rotation = parseRot(script, new Map([['arcane', 'Arcane'], ['estella', 'Estella']]));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    // SP is not what this is about: without a wait the set's 20 s outlast the rotation.
    return simulate(rotation.steps, team, FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 1000 },
    });
  };
  const deepRampart = (buffs: ReturnType<typeof trackBuffs>['after'][number]) =>
    buffs.filter((buff) => buff.effect.id === 'gear-set.deep-rampart.deep-rampart' && buff.apply.stat === 'arts_intensity');

  it('a Nature Burst triggers Deep Rampart: "applies Nature Burst"', () => {
    const sim = play('team: Arcane\nArcane: BS\nArcane: BS');
    const buffs = trackBuffs(sim.frames, [{ key: 'Arcane', active: arcane }]);
    // The first stack is an Infliction, the second one a Burst.
    expect(deepRampart(buffs.after[0]!)).toEqual([]);
    expect(deepRampart(buffs.after[1]!).map((buff) => buff.stacks)).toEqual([1]);
  });

  it("Corrosion's shred takes the applier's Arts Intensity with track buffs", () => {
    // Burst (+16 AI), Estella's Cryo eats the Nature, Cryo again, Arcane's Nature on it → Corrosion.
    const sim = play('team: Arcane, Estella\nArcane: BS\nArcane: BS\nEstella: BS\nEstella: BS\nArcane: BS');
    const at = 4;
    expect(sim.frames[at]!.target.debuffs.find((debuff) => debuff.term === 'Corrosion')?.source).toBe('Arcane');

    const gear = ['Deep Rampart Gauntlets', 'Deep Rampart Armor', 'Deep Rampart Comms', null].map((key) =>
      key ? { key, tier: bundle.gear.pieces[key]!.stats[0]!.values.length - 1 } : null,
    );
    const build: Build = { ...emptyBuild('Arcane'), gear };
    const damage = trackDamage(
      bundle,
      { frames: sim.frames, length: sim.real, team: ['Arcane', 'Estella'] },
      (key) => (key === 'Arcane' ? build : emptyBuild(key)),
      null,
    );
    const shred = damage.standing[at]!.find((buff) => buff.effect.id === 'status.corrosion')!.apply.value;

    const bare = analyse(build, bundle, { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} })!;
    const maxBonus = bare.effects.modifiers.reactionMax.Corrosion ?? 0;
    const stacks = deepRampart(trackBuffs(sim.frames, [{ key: 'Arcane', active: bare.effects.active }]).after[at]!);
    expect(stacks.map((buff) => buff.stacks)).toEqual([1]);
    expect(shred).toBeCloseTo(corrosionShred(1, bare.sheet.artsIntensity + 16, 0, maxBonus), 12);
    expect(shred).toBeGreaterThan(corrosionShred(1, bare.sheet.artsIntensity, 0, maxBonus));
  });
});
