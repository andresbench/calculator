/**
 * Which Stagger rows a cast deals (`StatRow.stagger`, `export.py`, `stagger_roles`).
 *
 * A Stagger row takes the condition of the hit it belongs to: Pogranichnik's
 * `Enhanced SEQ 3 Stagger` replaces the plain third slash on four stacks, and
 * fewer stacks make fewer slashes; Tangtang's `Early Rogue Wave Stagger` has
 * no condition the track can check and is not counted; a `CS1` step deals
 * only its own stage's row.
 */

import { expect, it } from 'vitest';

import { buildAliases, FALLBACK_SP, FALLBACK_TIMINGS, parseRot, simulate, statAt, targetFor } from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('Stagger rows follow their hits', (bundle) => {
  const meter = { ...targetFor(bundle, null), staggerMeter: 10_000, staggerRecovery: 10 };
  const run = (team: string, script: string) => {
    const rotation = parseRot(`team: ${team}\n${script}`, buildAliases(bundle));
    return simulate(rotation.steps, teamOf(bundle, rotation.team, rotation.steps), FALLBACK_TIMINGS, {
      synergy: bundle.synergy,
      sp: { ...FALLBACK_SP, ...bundle.sp, passiveRegen: 1000 },
      ultimatesCharged: true,
      target: meter,
    });
  };
  /**
   * What the step's own rows dealt: the gauge's rise minus the Stagger of the
   * Lift and Knock Down it applied (10 each with no build, measurements, #62).
   */
  const dealt = (sim: ReturnType<typeof run>, step: number) => {
    const frame = sim.frames[step]!;
    const statuses = frame.status.filter(
      (event) => (event.term === 'Lift' || event.term === 'Knock Down') && !event.appliedVulnerableInstead,
    ).length;
    return frame.target.stagger - (step > 0 ? sim.frames[step - 1]!.target.stagger : 0) - 10 * statuses;
  };
  const row = (operator: string, type: string, label: string) =>
    statAt(bundle.operators[operator]!.skills.find((skill) => skill.type === type)!, label, 12)!;

  it("Pogranichnik's combo: the enhanced third slash replaces the plain one on four stacks", () => {
    // The Breach window of `rotations/archive/endmin-core.rot`: four stacks, Breach eats them, the combo follows.
    const sim = run(
      'Chen Qianyu, Endministrator, Ember, Pogranichnik',
      'Chen Qianyu: BS > CS\nEndministrator: CS\nEmber: CS\nChen Qianyu: CS\nPogranichnik: BS\nPogranichnik: CS',
    );
    const combo = sim.frames[6]!;
    expect(combo.enhanced).toBe(true);
    const seq = (n: number) => row('Pogranichnik', 'Combo Skill', `SEQ ${n} Stagger`);
    expect(dealt(sim, 6)).toBe(seq(1) + seq(2) + row('Pogranichnik', 'Combo Skill', 'Enhanced SEQ 3 Stagger'));
  });

  it('…and fewer stacks, fewer slashes', () => {
    const sim = run('Chen Qianyu, Pogranichnik', 'Chen Qianyu: BS > CS\nPogranichnik: BS\nPogranichnik: CS');
    expect(sim.frames[3]!.moves).toBe(2);
    expect(dealt(sim, 3)).toBe(row('Pogranichnik', 'Combo Skill', 'SEQ 1 Stagger') + row('Pogranichnik', 'Combo Skill', 'SEQ 2 Stagger'));
  });

  it("Tangtang's early Rogue Wave is not counted: its condition is not on the track", () => {
    const sim = run('Tangtang', 'Tangtang: ULT');
    expect(dealt(sim, 0)).toBe(row('Tangtang', 'Ultimate', 'Rogue Wave Stagger'));
  });

  it("`CS1 > CS2`: Rossi's second stage deals the stage's Stagger, the first none", () => {
    const sim = run('Rossi, Chen Qianyu', 'Chen Qianyu: CS\nRossi: CS1 > CS2');
    expect(dealt(sim, 1)).toBe(0);
    expect(dealt(sim, 2)).toBe(row('Rossi', 'Combo Skill', 'SEQ 2 Stagger'));
  });
});
