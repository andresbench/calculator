/**
 * The press schedule (ENGINE_CORE_PLAN.md, §3): a step is a press made at
 * the earliest moment it is allowed, and other operators' skills run in
 * parallel with the controlled operator's chain.
 *
 * The example is the plan's, from the video of measurements #63: Lifeng's
 * battle skill in the background, the Endministrator's chain, Chen's combo
 * opened by Lifeng's hit. Times are the client's frames as the bundle has
 * them, so the test reads them from the bundle rather than writing them out.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  formatMessage,
  parseRot,
  simulate,
  trackDamage,
  type Bundle,
  type SimulateOptions,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('press schedule', (data: Bundle) => {
  const aliases = buildAliases(data);
  const run = (text: string, extra: SimulateOptions = {}) => {
    const rotation = parseRot(text, aliases);
    const team = teamOf(data, rotation.team, rotation.steps);
    return simulate(rotation.steps, team, data.timings ?? FALLBACK_TIMINGS, {
      sp: data.sp ?? FALLBACK_SP,
      synergy: data.synergy,
      ...extra,
    });
  };
  const basic = (key: string) => data.sp!.basicAttack![key]!;
  const example =
    'team: Endministrator, Lifeng, Chen Qianyu\nLifeng: BS\nEndministrator: BA\nChen Qianyu: CS\nEndministrator: FS';

  it("the chain runs on through another operator's battle skill, and a combo slows it (#64)", () => {
    const sim = run(example);
    const [bs, ba, cs, fs] = sim.frames;
    const lifeng = basic('Lifeng').skillWindows!.BS!;
    const endmin = basic(sim.frames[1]!.step.actor!);
    // Her chain does not wait for his battle skill (#71).
    expect(ba!.world - bs!.world).toBeCloseTo(0, 6);
    // Chen's combo waits for the hit that opens it.
    expect(cs!.world - bs!.world).toBeCloseTo(lifeng.lands!, 6);
    // The Final Strike follows her own chain, which crawls through Chen's slowdown.
    const slowdown = basic('Chen Qianyu').skillWindows!.CS!.dilation! * (1 - data.timings!.comboTimeScale!);
    expect(fs!.world - ba!.world).toBeCloseTo(endmin.sequenceSeconds! - endmin.finalStrikeSeconds! + slowdown, 6);
    expect(fs!.chained).toBe(true);
  });

  it('presses never go back in time, and the rotation ends with its last action', () => {
    const sim = run(example);
    for (const [index, frame] of sim.frames.entries()) {
      if (index > 0) expect(frame.world).toBeGreaterThanOrEqual(sim.frames[index - 1]!.world);
    }
    const ends = sim.frames.map((frame) => frame.world + frame.duration);
    expect(sim.world).toBeCloseTo(Math.max(...ends), 6);
  });

  it("a combo opened by a Final Strike comes on the strike's hit, not its press", () => {
    const sim = run('team: Arcane, Perlica\nArcane: BA > FS\nPerlica: CS');
    const [, fs, cs] = sim.frames;
    const arcane = basic('Arcane');
    // The first hit of the chain's last segment, from where the BA stopped.
    const hit = arcane.chainHits!.at(-1)![0]! - (arcane.sequenceSeconds! - arcane.finalStrikeSeconds!);
    expect(hit).toBeGreaterThan(0);
    expect(cs!.world - fs!.world).toBeCloseTo(hit, 6);
    expect(cs!.verdicts.get(`${cs!.step.index}:waitsForStrike`)?.code).toBe('waitsForStrike');
  });

  it("a hit that lands after a later press is counted under what stands then", () => {
    const sim = run(example);
    const damage = trackDamage(
      data,
      { frames: sim.frames, length: sim.real, team: ['Endministrator (female)', 'Lifeng', 'Chen Qianyu'] },
      (key) => emptyBuild(key),
      null,
    );
    // Her fourth hit comes 2.27 s into the chain, after Chen's combo at 2.0 s.
    const chain = damage.steps[1]!.parts.map((part) => part.label);
    expect(chain.some((label) => /^BATK SEQ 4 Multiplier × 1 \(2\.0 s\)$/.test(label))).toBe(true);
    expect(chain.some((label) => /^BATK SEQ 1 Multiplier$/.test(label))).toBe(true);
    // A nominal second has no hit times: everything stays at the press.
    const nominal = run(example, { sp: FALLBACK_SP });
    const flat = trackDamage(data, { frames: nominal.frames, length: nominal.real, team: ['Endministrator (female)', 'Lifeng', 'Chen Qianyu'] }, (key) => emptyBuild(key), null);
    expect(flat.steps.flatMap((step) => step.parts).some((part) => / s\)$/.test(part.label))).toBe(false);
  });

  it('a combo written before its cooldown ends says how long it waits', () => {
    const sim = run('Chen Qianyu: BS\nChen Qianyu: CS\nChen Qianyu: BS\nChen Qianyu: CS');
    const second = sim.frames[3]!;
    const verdict = second.verdicts.get(`${second.step.index}:cooldown`)!;
    expect(verdict.code).toBe('comboOnCooldown');
    const waited = sim.waits.filter((wait) => wait.step === second.step.index && wait.reason === 'combo cooldown');
    expect(waited).toHaveLength(1);
    expect(verdict.code === 'comboOnCooldown' && verdict.seconds).toBeCloseTo(waited[0]!.seconds, 6);
    expect(formatMessage(verdict)).toMatch(/^on cooldown: waits \d+\.\d s$/);
  });
});
