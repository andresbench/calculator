/**
 * `team_cast:<type>` — a cast of that type by anyone in the squad. Type 50
 * Yinglung: «When any operator in the team casts a battle skill, the wearer
 * gains 1 stack of Yinglung's Edge» (audit 2026-11-12, В17 — `cast:` fires
 * only on the wearer's own cast).
 */

import { expect, it } from 'vitest';

import { activeEffects, buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, trackBuffs, type Bundle } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('a team-wide cast trigger', (bundle: Bundle) => {
  it("Type 50 Yinglung stacks on the squad's battle skills, not only the wearer's", () => {
    const rotation = parseRot('team: Chen, Lifeng, Pogranichnik\nLifeng: BS\nPogranichnik: BS\nChen: BS\nChen: WAIT 1s', buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: bundle.sp ?? FALLBACK_SP,
    });
    const holders = [...team.keys()].map((key) => ({
      key,
      active: activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0, sets: key === 'Chen Qianyu' ? { 'Type 50 Yinglung': 3 } : {} }),
    }));
    const timeline = trackBuffs(frames, holders);
    const edge = timeline.after.map((list) =>
      list.filter((buff) => buff.receiver === 'Chen Qianyu' && buff.apply.name === "Yinglung's Edge").reduce((sum, buff) => sum + buff.stacks, 0),
    );
    expect(edge).toEqual([1, 2, 3, 3]);
  });
});
