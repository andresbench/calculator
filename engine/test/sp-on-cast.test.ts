/**
 * SP a potential returns on a cast, and the track's general caveats.
 *
 * Rossi's P1 — «Wolven Ambrage of the battle skill also returns 10 SP after
 * hitting the enemy» — and Yvonne's P4 — «If the explosion hits only one
 * enemy, return 10 SP» (one dummy, so it does) — are `sp_return` on
 * `cast:Battle Skill`. The simulation used to read only `consumes:` returns,
 * and the buff track took these for buffs with no duration.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simModifiersFor,
  simulate,
  trackDamage,
  type Bundle,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('SP returned on a cast; caveats only where they apply', (bundle: Bundle) => {
  const run = (text: string, potential = 0) => {
    const rotation = parseRot(text, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const modifiers = simModifiersFor(bundle, team, () => potential);
    const sim = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      sp: bundle.sp ?? FALLBACK_SP,
      synergy: bundle.synergy,
      modifiers,
    });
    return { sim, team };
  };

  for (const key of ['Rossi', 'Yvonne']) {
    it(`${key}: the battle skill gives back 10 SP with the potential, none without`, () => {
      const without = run(`${key}: BS`, 0).sim.frames[0]!.sp;
      const withIt = run(`${key}: BS`, 5).sim.frames[0]!.sp;
      expect(withIt - without).toBeCloseTo(10, 6);
    });
  }

  const caveats = (text: string) => {
    const { sim, team } = run(text);
    const damage = trackDamage(bundle, { frames: sim.frames, length: sim.real, team: [...team.keys()] }, (key) => emptyBuild(key), null);
    return damage.notCounted.map((item) => item.message.code);
  };

  it('no Corrosion, no Link, no stagger meter: their caveats stay out', () => {
    const codes = caveats('Chen Qianyu: BS\nChen Qianyu: WAIT 2s\nChen Qianyu: BS');
    expect(codes).not.toContain('trackCorrosion');
    expect(codes).not.toContain('trackLink');
    expect(codes).not.toContain('trackStaggerAtStart');
    expect(codes).toContain('trackHitTimes');
  });

  it('a rotation that spends Link gets the Link caveat', () => {
    expect(caveats('Lifeng: BS > FS > CS > BS')).toContain('trackLink');
  });

  it('an SP return is no buff without a duration', () => {
    const { sim, team } = run('Endministrator (female): CS > BS', 1);
    const damage = trackDamage(bundle, { frames: sim.frames, length: sim.real, team: [...team.keys()] }, (key) => ({ ...emptyBuild(key), potential: 1 }), null);
    expect(damage.notCounted.map((item) => item.message.code)).not.toContain('buffNoDuration');
  });
});
