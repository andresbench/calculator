/**
 * Golden test: a combo slows the world, stays ready for 6 s, may follow
 * another at once; a cutscene stops the chain; which hit stops count.
 *
 * Source — `docs/measurements.md`, #64–#68, Teo's 60 fps videos of
 * 2026-11-06 against Rhodagn. Every time below is a recording frame: a mark
 * is good to a frame on either side, so two marks give ±2 frames of 60.
 *
 * * #64 — the Endministrator's chain, first hit → Final Strike: 3.383 s,
 *   with Chen's combo in the middle 3.983 s. Every combo begins with a
 *   `TimeDilationAction`; Chen's is 0.633 s, and the world runs ×0.05 in it.
 * * #65 — a combo's bubble burns 6.00, 5.95, 6.00 s after its trigger.
 * * #66 — Chen's, Lifeng's and the Endministrator's combos pressed one after
 *   another: Chen's hit came 2.1 s after her press, Lifeng's second 1.8 s
 *   after his first — each stood still under the later combos.
 * * #67 — Chen's ultimate mid-chain: the chain stopped between two segments
 *   and went on after the cutscene, 1.83 s later (an accidental battle skill
 *   of Chen's came first).
 * * #68 — `affectType` 2 hit stops hold the attacker (the chain is 0.06 s
 *   longer per 0.06 stop), 1 only the target (Lifeng's combo); a Final
 *   Strike opens combos on its SP hit (Lifeng's second).
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  emptyBuild,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  parseRot,
  simulate,
  trackDamage,
  timerEnd,
  warp,
  type Bundle,
  type Dilation,
  type SimulateOptions,
} from '../../src/index.js';
import { describeWithBundle, teamOf } from '../support/bundle.js';

/** Two marks on a 60 fps recording. */
const MARKS = 2 / 60;
const ENDMIN = 'Endministrator (female)';

describeWithBundle('combo slowdown, combo window, hit stop (measurements, #64–#68)', (data: Bundle) => {
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
  const scale = data.timings!.comboTimeScale!;
  const endmin = basic(ENDMIN);
  /** From the chain's first hit to the Final Strike's hit, for a `BA` + `FS` run. */
  const toStrike = (sim: ReturnType<typeof run>) => {
    const ba = sim.frames.find((frame) => frame.step.kind === 'BA')!;
    const fs = sim.frames.find((frame) => frame.step.kind === 'FS')!;
    const strike = endmin.finalStrikeHit! - (endmin.sequenceSeconds! - endmin.finalStrikeSeconds!);
    return fs.world + strike - (ba.world + endmin.chainHits![0]![0]!);
  };
  const team = 'team: Endministrator, Lifeng, Chen Qianyu\n';

  it('the chain on an enemy takes its own hit stops: 3.383 s to the Final Strike (#68b)', () => {
    expect(Math.abs(endmin.finalStrikeHit! - endmin.chainHits![0]![0]! - 3.383)).toBeLessThanOrEqual(MARKS);
    // The same with Lifeng's battle skill pressed mid-chain: it does not hold it.
    const withBattle = run(`${team}Endministrator: BA\nLifeng: BS\nEndministrator: FS`);
    expect(Math.abs(toStrike(withBattle) - 3.383)).toBeLessThanOrEqual(MARKS);
  });

  it("another operator's combo slows the chain by 0.60 s (#64)", () => {
    const without = run(`${team}Endministrator: BA\nLifeng: BS\nEndministrator: FS`);
    const withCombo = run(`${team}Endministrator: BA\nLifeng: BS\nChen Qianyu: CS\nEndministrator: FS`);
    expect(withCombo.frames[2]!.verdicts.get(`${withCombo.frames[2]!.step.index}:slows`)?.code).toBe('comboSlowsWorld');
    expect(Math.abs(toStrike(withCombo) - toStrike(without) - 0.6)).toBeLessThanOrEqual(MARKS);
  });

  it('a combo stays ready 6 s after its trigger (#65)', () => {
    // Knock Down lands 2.0 s after Lifeng's cast; his window is over at 2.47 s.
    const window = basic('Lifeng').skillWindows!.BS!;
    const pause = (late: number) => (late - (window.seconds - window.lands!)).toFixed(4);
    const expired = (late: number) =>
      run(`team: Lifeng, Chen Qianyu\nLifeng: BS\nLifeng: WAIT ${pause(late)}s\nChen Qianyu: CS`)
        .frames[2]!.problems.some((problem) => problem.code === 'comboExpired');
    expect(expired(6 - 0.1)).toBe(false);
    expect(expired(6 + 0.1)).toBe(true);
  });

  it('a second combo follows at once, and a combo stands still under the ones after it (#66)', () => {
    const sim = run(
      `${team}Endministrator: BA\nLifeng: BS\nEndministrator: FS\nLifeng: CS\nChen Qianyu: CS`,
    );
    const [, , , lifeng, chen] = sim.frames;
    // Pressed 0.15 s apart on video: the fingers, nothing in the game.
    expect(chen!.world - lifeng!.world).toBeLessThanOrEqual(0.16);
    // Lifeng's hits come later by Chen's slowdown, which he is not exempt from.
    const damage = trackDamage(data, { frames: sim.frames, length: sim.real, team: [ENDMIN, 'Lifeng', 'Chen Qianyu'] }, (key) => emptyBuild(key), null);
    expect(damage.steps[3]!.parts.length).toBeGreaterThan(0);

    // The measured presses, played through the model.
    const dilation = (key: string) => basic(key).skillWindows!.CS!.dilation!;
    const chenHit = basic('Chen Qianyu').skillHits!.CS![0]!.at;
    const lifengSecond = basic('Lifeng').skillHits!.CS![1]!.at;
    for (const shot of [
      { chen: 13.217, lifeng: 13.367, endmin: 14.1, chenHit: 15.317, lifengHit: 15.8 },
      { chen: 33.45, lifeng: 33.613, endmin: 34.383, chenHit: 35.6, lifengHit: 36.033 },
    ]) {
      const spans: Dilation[] = [
        { from: shot.chen, until: shot.lifeng, exempt: 'Chen Qianyu', step: 0, scale, timers: true },
        { from: shot.lifeng, until: shot.endmin, exempt: 'Lifeng', step: 1, scale, timers: true },
        { from: shot.endmin, until: shot.endmin + dilation(ENDMIN), exempt: ENDMIN, step: 2, scale, timers: true },
      ];
      expect(Math.abs(warp(spans, shot.chen, chenHit, 'Chen Qianyu') - shot.chenHit)).toBeLessThanOrEqual(MARKS);
      expect(Math.abs(warp(spans, shot.lifeng, lifengSecond, 'Lifeng') - shot.lifengHit)).toBeLessThanOrEqual(MARKS);
    }
  });

  it("a combo opened by another combo comes on that combo's hit (#66)", () => {
    const sim = run('team: Chen Qianyu, Pogranichnik, Endministrator\nChen Qianyu: BS\nChen Qianyu: CS\nEndministrator: CS');
    const [, chen, endministrator] = sim.frames;
    expect(endministrator!.verdicts.get(`${endministrator!.step.index}:waitsForComboHit`)?.code).toBe('waitsForComboHit');
    expect(endministrator!.world - chen!.world).toBeCloseTo(basic('Chen Qianyu').skillHits!.CS![0]!.at, 6);
  });

  it("Lifeng's combo: the 1.333 s hit stop holds only the target (#68a)", () => {
    const [first, second] = basic('Lifeng').skillHits!.CS!;
    // 0.933 / 0.920 s between the hits once the Endministrator's slowdown is taken out.
    expect(Math.abs(second!.at - first!.at - 0.93)).toBeLessThanOrEqual(MARKS + 0.02);
  });

  it("a Final Strike opens combos on its SP hit: Lifeng's second (#68c)", () => {
    const lifeng = basic('Lifeng');
    const last = lifeng.chainHits!.at(-1)!;
    expect(lifeng.finalStrikeHit).toBeCloseTo(last[1]!, 4);
    expect(Math.abs(last[1]! - last[0]! - 0.364)).toBeLessThanOrEqual(MARKS);
    expect(endmin.finalStrikeHit).toBeCloseTo(endmin.chainHits!.at(-1)![0]!, 4);
  });

  it('a debuff timer runs at the slowdown\'s pace: 11.93 s alone, 14.20 s through three combos (#70)', () => {
    const debuffOf = (sim: ReturnType<typeof run>) =>
      sim.frames.at(-1)!.target.debuffs.find((debuff) => debuff.term === 'Physical Susceptibility')!;
    const alone = debuffOf(run(`${team}Lifeng: BS\nLifeng: WAIT 1s`));
    const seconds = alone.expiresAt! - alone.appliedAt;
    // The icon's on/off by pixels: 11.93 s against the wiki's 12.
    expect(Math.abs(seconds - 11.933)).toBeLessThanOrEqual(MARKS + 0.05);
    // The measured presses: Chen 40.117, Lifeng 41.117, the Endministrator 42.067;
    // the icon from 38.767 to 52.967 — 2.27 s longer than alone.
    const dilation = (key: string) => basic(key).skillWindows!.CS!.dilation!;
    const spans: Dilation[] = [
      { from: 40.117, until: 40.117 + dilation('Chen Qianyu'), exempt: 'Chen Qianyu', step: 0, scale, timers: true },
      { from: 41.117, until: 41.117 + dilation('Lifeng'), exempt: 'Lifeng', step: 1, scale, timers: true },
      { from: 42.067, until: 42.067 + dilation(ENDMIN), exempt: ENDMIN, step: 2, scale, timers: true },
    ];
    expect(Math.abs(timerEnd(spans, 38.767, 11.933) - 52.967)).toBeLessThanOrEqual(MARKS + 0.05);
    // And the engine: the same debuff outlives the plain one by the slowdowns.
    const slowed = debuffOf(run(`${team}Endministrator: BA\nLifeng: BS\nEndministrator: FS\nLifeng: CS\nChen Qianyu: CS\nLifeng: WAIT 1s`));
    // Lifeng's slowdown is cut by Chen's at once: 0.633 s of it, ×0.95.
    expect(slowed.expiresAt! - slowed.appliedAt).toBeCloseTo(seconds + basic('Chen Qianyu').skillWindows!.CS!.dilation! * (1 - scale), 6);
  });

  it("a chain started right after another operator's battle skill does not wait for it (#71)", () => {
    const sim = run(`${team}Lifeng: BS\nEndministrator: BA`);
    // On video her first hit came 0.30 s after his press: no room for 8 frames + her 0.2 s.
    expect(sim.frames[1]!.world - sim.frames[0]!.world).toBeLessThan(0.3 - endmin.chainHits![0]![0]! + MARKS);
  });

  it('a dive: 0.52 s to the landing hit, the landing from the client (#21)', () => {
    const sim = run('Chen Qianyu: DIVE\nChen Qianyu: DIVE');
    const chen = basic('Chen Qianyu').dive!;
    expect(sim.frames[1]!.world - sim.frames[0]!.world).toBeCloseTo(chen.seconds, 6);
    // On video the next jump came 1.13 s after the hit at the quickest: the window is shorter.
    expect(chen.seconds - chen.hit).toBeLessThanOrEqual(1.13);
    expect(Math.abs(chen.hit - 0.52)).toBeLessThanOrEqual(MARKS);
  });

  it("Chen's finisher: hits 1.00 s apart, the next attack 2.20 s after the press (#21)", () => {
    const fin = basic('Chen Qianyu').finisher!;
    // 20 349 at 47.70, 81 398 at 48.70, the next attack's 1 471 at 50.00.
    expect(Math.abs(fin.hits[1]! - fin.hits[0]! - 1.0)).toBeLessThanOrEqual(MARKS);
    const nextHit = basic('Chen Qianyu').chainHits![0]![0]!;
    expect(Math.abs(fin.seconds - fin.hits[1]! + nextHit - 1.3)).toBeLessThanOrEqual(MARKS);
  });

  it("a finisher holds no one else: Pogranichnik's battle skill went 0.32 s in, his own hand (#21)", () => {
    const sim = run('team: Chen Qianyu, Pogranichnik\nChen Qianyu: FIN\nPogranichnik: BS');
    const [fin, battle] = sim.frames;
    expect(battle!.world - fin!.world).toBeLessThanOrEqual(0.32);
  });

  it('a lit combo is offered from its trigger, and not after it goes dark (#65)', () => {
    const sim = run(
      `${team}Lifeng: BS\nEndministrator: BA\nEndministrator: FS\nLifeng: CS\nEndministrator: BA\nEndministrator: FS\nEndministrator: BA\nEndministrator: FS`,
    );
    const lifeng = (index: number) => sim.frames[index]!.combos.find((combo) => combo.key === 'Lifeng');
    // His combo lights on the first Final Strike's hit, not on its press.
    const strike = sim.frames[2]!;
    expect(lifeng(2)?.openedAt).toBeGreaterThan(strike.world);
    // Cast, then on cooldown: a strike while the button is grey lights nothing
    // (#72); only one after the cooldown does.
    const cast = sim.frames[3]!;
    const back = cast.cooldowns['Lifeng:Combo Skill']!;
    for (const [index, frame] of sim.frames.entries()) {
      const combo = lifeng(index);
      if (index > 3 && combo) expect(combo.at).toBeLessThanOrEqual(combo.openedAt! + data.timings!.comboReady! + 1e-6);
      if (index > 3 && combo) expect(combo.openedAt!).toBeGreaterThanOrEqual(back - 1e-6);
      void frame;
    }
  });

  it('a combo pressed on a trigger that came during its cooldown is flagged (#72)', () => {
    const sim = run(`${team}Lifeng: BS\nChen Qianyu: CS\nLifeng: BS\nChen Qianyu: CS`);
    const second = sim.frames[3]!;
    expect(second.problems.some((problem) => problem.code === 'comboTriggerOnCooldown')).toBe(true);
  });

  it("another operator's combo lights the Endministrator's on its hit (#66)", () => {
    const sim = run(`${team}Lifeng: BS\nChen Qianyu: CS`);
    const chen = sim.frames[1]!;
    const endmin = chen.combos.find((combo) => combo.key === ENDMIN)!;
    expect(endmin.openedAt).toBeCloseTo(chen.world + basic('Chen Qianyu').skillHits!.CS![0]!.at, 6);
  });

  it('sp: unlimited — battle skills never wait, energy still comes from the SP spent', () => {
    const text = 'Chen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: BS\nChen Qianyu: BS';
    const limited = run(text);
    const free = run(`sp: unlimited\n${text}`, { unlimitedSp: true });
    expect(limited.waits.some((item) => item.reason === 'SP regenerating')).toBe(true);
    expect(free.waits.some((item) => item.reason === 'SP regenerating')).toBe(false);
    expect(free.frames.at(-1)!.energy['Chen Qianyu']).toBeGreaterThan(0);
    // The header round-trips through the notation.
    expect(parseRot(`sp: unlimited\n${text}`).unlimitedSp).toBe(true);
  });

  it("another operator's ultimate stops the chain for its cutscene (#67)", () => {
    const alone = run(`${team}Endministrator: BA\nEndministrator: FS`);
    const ultimate = run(`${team}Endministrator: BA\nChen Qianyu: ULT\nEndministrator: FS`, { ultimatesCharged: true });
    const delay = toStrike(ultimate) - toStrike(alone);
    expect(delay).toBeCloseTo(basic('Chen Qianyu').skillWindows!.ULT!.cutscene!, 6);
    // On video: the cutscene 1.617 s on screen, the chain 1.83 s late with a battle skill before it.
    expect(delay).toBeGreaterThanOrEqual(1.617 - MARKS);
    expect(delay).toBeLessThanOrEqual(1.833 + MARKS);
  });
});
