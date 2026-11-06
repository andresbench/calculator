/**
 * SP the stat table leaves out or puts in the wrong place, as the skill text
 * states it (`export.py`: `stage_costs`, `sp_counts`, `transformed_rows`).
 *
 * * Mi Fu: «Cloudtrapper: Costs 100 SP and returns 50 SP after casting».
 * * Si: «Final Stroke: Costs no SP» — the cost row has no third stage.
 * * Akekuri: «2 thrust sequences, with each sequence … recovering some SP».
 * * Tangtang: «SP Return per Whirlpool» waits on whirlpools, which the
 *   engine has none of — the battle skill returns nothing.
 * * Camille: «After casting the ultimate, Camille's battle skill is
 *   temporarily transformed into Hunter Pursuit. Hunter Pursuit: Treated as
 *   a combo skill and costs no SP … recovers some SP» — its rows sat in his
 *   combo skill and were counted on every combo.
 *
 * Passive regen is off, so a frame's SP change is the step's own.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  statAt,
  trackDamage,
  type Build,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const MAXED = { basic: 12, battle: 12, combo: 12, ultimate: 12 };

describeWithBundle('SP from the skill text', (bundle) => {
  const play = (team: string, script: string) => {
    const rotation = parseRot(`team: ${team}\n${script}`, buildAliases(bundle));
    return simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, passiveRegen: 0 },
      ultimatesCharged: true,
    });
  };
  const deltas = (sim: ReturnType<typeof play>) => sim.frames.slice(1).map((frame, i) => frame.sp - sim.frames[i]!.sp);
  const skillOf = (operator: string, type: string) => bundle.operators[operator]!.skills.find((skill) => skill.type === type)!;
  const at12 = (operator: string, type: string, label: string, sequence: number | null = null) =>
    statAt(skillOf(operator, type), label, 12, sequence)!;

  it("Mi Fu's Cloudtrapper costs 100 and returns 50", () => {
    const sim = play('Mi Fu', 'Mi Fu: WAIT 1s\nMi Fu: BS1\nMi Fu: BS2\nMi Fu: BS3');
    expect(deltas(sim)).toEqual([-50, -50, -50]);
  });

  it("Si's Final Stroke costs nothing", () => {
    const sim = play('Si', 'Si: WAIT 1s\nSi: BS1\nSi: BS2\nSi: BS3');
    expect(deltas(sim)).toEqual([-100, -15, 0]);
  });

  it("Akekuri's combo recovers per sequence, twice", () => {
    const recovered = play('Akekuri', 'Akekuri: CS').frames[0]!.spRecovered;
    expect(recovered).toBe(2 * at12('Akekuri', 'Combo Skill', 'SP Recovery per SEQ'));
  });

  it("Tangtang's battle skill returns no whirlpool SP without whirlpools", () => {
    const sim = play('Tangtang', 'Tangtang: WAIT 1s\nTangtang: BS');
    expect(deltas(sim)).toEqual([-at12('Tangtang', 'Battle Skill', 'SP Cost')]);
  });

  camilleCases();

  function camilleCases(): void {
    const script = 'Camille: BS\nCamille: CS\nCamille: ULT\nCamille: BS\nCamille: BS';
    const sim = () => play('Camille', script);
    const damage = () =>
      trackDamage(
        bundle,
        { frames: sim().frames, length: sim().real, team: ['Camille'] },
        (key): Build => ({ ...emptyBuild(key), skills: MAXED }),
        null,
      );
    const labels = (index: number) => damage().steps[index]!.parts.filter((part) => !part.status).map((part) => part.label);

    it("Camille's combo deals its own hit, not Hunter Pursuit's", () => {
      expect(labels(1)).toEqual(['DMG Multiplier']);
    });

    it('after the ultimate the battle skill is Hunter Pursuit: free, recovers SP, a combo-type hit', () => {
      const frames = sim().frames;
      expect(frames[3]!.transformed).toEqual({ into: 'Hunter Pursuit', as: 'Combo Skill' });
      expect(frames[3]!.sp - frames[2]!.sp).toBe(at12('Camille', 'Combo Skill', 'Hunter Pursuit SP Recovery'));
      expect(labels(3)).toEqual(['Hunter Pursuit DMG Multiplier']);
      // Once: the next battle skill is the battle skill again.
      expect(frames[4]!.transformed).toBeNull();
      expect(frames[4]!.sp - frames[3]!.sp).toBe(-at12('Camille', 'Battle Skill', 'SP Cost'));
      expect(labels(4)).not.toContain('Hunter Pursuit DMG Multiplier');
    });

    it('the window closes after Hunter Pursuit State Duration', () => {
      const seconds = at12('Camille', 'Ultimate', 'Hunter Pursuit State Duration (s)');
      const late = play('Camille', `Camille: ULT\nCamille: WAIT ${seconds + 1}s\nCamille: BS`);
      expect(late.frames[2]!.transformed).toBeNull();
    });
  }
});
