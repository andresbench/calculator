/**
 * A potential that edits another effect (`Effect.modifies`): the edit reaches
 * the rows of the named talent and nothing else (audit 2026-11-12, В12, В13).
 *
 * * Pogranichnik's P3 «Talent The Living Banner improved: … Max Fervent
 *   Morale stacks on self +2» — Tactical Instruction also puts Fervent Morale
 *   up, on the spender; the edit used to replace its trigger and switch it off.
 * * The Endministrator's P2 «other allied operators gain half of this ATK
 *   buff» — `teamShare` on Essence Disintegration.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { activeEffects, buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, trackBuffs, type Bundle } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('a potential that modifies another effect', (bundle: Bundle) => {
  const play = (script: string, potentialOf: (key: string) => number) => {
    const rotation = parseRot(script, buildAliases(bundle));
    const team = teamOf(bundle, rotation.team, rotation.steps);
    const { frames } = simulate(rotation.steps, team, bundle.timings ?? FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...(bundle.sp ?? FALLBACK_SP), passiveRegen: 1000 },
      ultimatesCharged: true,
    });
    const holders = [...team.keys()].map((key) => ({
      key,
      active: activeEffects(bundle.effects, { operator: key, elite: 4, potential: potentialOf(key) }),
    }));
    return { frames, timeline: trackBuffs(frames, holders) };
  };

  it("Pogranichnik's P3 edits The Living Banner and leaves Tactical Instruction alone", () => {
    const script = 'team: Pogranichnik, Chen Qianyu\nPogranichnik: ULT\nChen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: BS\nChen Qianyu: BS';
    const stacksAt = (potential: number) => {
      const { timeline } = play(script, (key) => (key === 'Pogranichnik' ? potential : 0));
      return timeline.after.map((list) =>
        list
          .filter((buff) => buff.receiver === 'Chen Qianyu' && buff.apply.stat === 'atk_pct' && buff.effect.source.name === 'Tactical Instruction')
          .reduce((sum, buff) => sum + buff.stacks, 0),
      );
    };
    expect(stacksAt(2)).toEqual([0, 0, 1, 2, 3]);
    expect(stacksAt(3)).toEqual(stacksAt(2));
  });

  it("the Endministrator's P2 gives the rest of the squad half of Essence Disintegration", () => {
    const text = readFileSync(fileURLToPath(new URL('../../rotations/endmin-core.rot', import.meta.url)), 'utf8');
    const { timeline } = play(text, (key) => (key.startsWith('Endministrator') ? 2 : 0));
    const scales = new Map<string, number>();
    for (const list of timeline.after) {
      for (const buff of list) if (buff.effect.source.name === 'Essence Disintegration') scales.set(buff.receiver, buff.scale);
    }
    const endmin = [...scales.keys()].find((key) => key.startsWith('Endministrator'))!;
    expect(scales.get(endmin)).toBe(1);
    const others = [...scales].filter(([key]) => key !== endmin);
    expect(others.length).toBeGreaterThan(0);
    for (const [, scale] of others) expect(scale).toBe(0.5);
  });
});
