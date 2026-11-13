/**
 * Eternal Xiranite: «After the wearer applies Amp, Protection, Susceptibility,
 * or Weakness, other teammates gain DMG Dealt +16%». The set text says
 * Protection and Weakness; the engine's terms are Protect and Weaken (audit
 * 2026-11-12, В16).
 */

import { expect, it } from 'vitest';

import { activeEffects, buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, trackBuffs, type Bundle } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('Eternal Xiranite on Protect and Weaken', (bundle: Bundle) => {
  const play = (wearer: string, cast: string) => {
    const script = `team: ${wearer}, Chen Qianyu\nChen Qianyu: BS\n${wearer}: ${cast}\nChen Qianyu: BS\nChen Qianyu: WAIT 1s`;
    const rotation = parseRot(script, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...(bundle.sp ?? FALLBACK_SP), passiveRegen: 1000 },
      ultimatesCharged: true,
    });
    const holders = [...team.keys()].map((key) => ({
      key,
      active: activeEffects(bundle.effects, { operator: key, elite: 4, potential: 0, sets: key === wearer ? { 'Eternal Xiranite': 3 } : {} }),
    }));
    const timeline = trackBuffs(frames, holders);
    const armed = timeline.after.map((list) =>
      list.filter((buff) => buff.effect.item === 'Eternal Xiranite' && buff.apply.stat === 'dmg_bonus').map((buff) => buff.receiver),
    );
    const applied = frames.flatMap((frame) => frame.applied.filter((item) => item.by === wearer).map((item) => item.term));
    return { armed, applied };
  };

  it("Camille's battle skill applies Weaken: Chen gets the +16 %", () => {
    const { armed, applied } = play('Camille', 'BS');
    expect(applied).toContain('Weaken');
    expect(armed[1]).toEqual(['Chen Qianyu']);
  });

  it("Purrchena's battle skill applies Protect: Chen gets the +16 %", () => {
    const { armed, applied } = play('Purrchena', 'BS');
    expect(applied).toContain('Protect');
    expect(armed[1]).toEqual(['Chen Qianyu']);
  });
});
