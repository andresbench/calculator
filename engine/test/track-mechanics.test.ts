/**
 * Track mechanics that the skill text states and the engine used to miss:
 * an action trigger (Final Strike), Link as a team buff, Originium Crystals,
 * a combo whose stacks decide its sequences, a stage that is a hit and not a
 * press, fillers, fixed team slots and a charged start.
 */

import { expect, it } from 'vitest';

import {
  buildAliases,
  FALLBACK_SP,
  FALLBACK_TIMINGS,
  formatRot,
  parseRot,
  simulate,
  slotOrder,
  spAt,
  stepHits,
  targetFor,
  timerEnd,
  ultimateCost,
  type Bundle,
  type SimulateOptions,
} from '../src/index.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

describeWithBundle('track mechanics from the skill text', (data: Bundle) => {
  const aliases = buildAliases(data);
  const options = (extra: SimulateOptions = {}): SimulateOptions => ({
    sp: data.sp ?? FALLBACK_SP,
    synergy: data.synergy,
    ...extra,
  });
  const run = (text: string, extra: SimulateOptions = {}, order: string[] = []) => {
    const rotation = parseRot(text, aliases);
    const team = teamOf(data, order.length ? order : rotation.team, rotation.steps);
    return simulate(rotation.steps, team, data.timings ?? FALLBACK_TIMINGS, options(extra));
  };
  const codes = (frame: { verdicts: Map<string, { code: string }> }) => [...frame.verdicts.values()].map((v) => v.code);

  it("Lifeng's combo waits for a Final Strike, not just for Physical Susceptibility", () => {
    const without = run('Lifeng: BS > CS');
    expect(without.frames[1]!.problems.map((p) => p.code)).toContain('triggerMissing');

    const withStrike = run('Lifeng: BS > FS > CS');
    expect(withStrike.frames[2]!.problems).toEqual([]);
    expect(codes(withStrike.frames[2]!)).toContain('triggerOpenedBy');

    // The condition is read at the Final Strike: an expired debuff is not there.
    const expired = run('Lifeng: BS > WAIT 60s > FS > CS');
    expect(expired.frames[3]!.problems.map((p) => p.code)).toContain('triggerMissing');
  });

  it("Antal's combo needs his Focus on the target, not just an infliction", () => {
    const team = ['Antal', 'Estella'];
    const bare = run('Estella: BS > Antal: CS', {}, team);
    expect(bare.frames[1]!.problems).toContainEqual({ code: 'triggerMissing', terms: [{ term: 'Focus' }], consumed: false });
    expect(run('Antal: BS > Estella: BS > Antal: CS', {}, team).frames[2]!.problems).toEqual([]);
  });

  it('a combo spent on an application does not reopen on it: Estella after her own Shatter', () => {
    const team = ['Estella', 'Alesh'];
    const frames = run('Alesh: BS > Estella: CS > Alesh: CS', {}, team).frames;
    expect(frames[1]!.problems).toEqual([]);
    expect(frames[2]!.combos.some((combo) => combo.key === 'Estella')).toBe(false);
  });

  it("Ardelia's combo opens on a Final Strike against a clean target, and stacks close it", () => {
    const clean = run('Ardelia: FS > CS');
    expect(clean.frames[1]!.problems).toEqual([]);
    expect(codes(clean.frames[1]!)).toContain('triggerOpenedBy');

    const cryo = run('Tangtang: BS > Ardelia: FS > CS', {}, ['Ardelia', 'Tangtang']);
    expect(cryo.frames[2]!.problems).toContainEqual({ code: 'triggerBlocked', terms: ['Arts Infliction'] });
    expect(cryo.frames[2]!.problems.map((p) => p.code)).not.toContain('triggerMissing');
  });

  it("Akekuri's combo opens on a Stagger Node or on the stagger itself", () => {
    const rhodagn = targetFor(data, 'Rhodagn the Bonekrushing Fist');
    expect(rhodagn.staggerNodes?.length).toBeGreaterThan(0);
    const steps = 'Chen Qianyu: BS > Akekuri: CS';
    const team = ['Akekuri', 'Chen Qianyu'];
    const node = run(steps, { target: { ...rhodagn, staggerNodes: [0.01] } }, team);
    expect(codes(node.frames[0]!)).toContain('staggerNode');
    expect(node.frames[1]!.problems).toEqual([]);

    const full = run(steps, { target: { ...rhodagn, staggerMeter: 1, staggerNodes: [] } }, team);
    expect(codes(full.frames[0]!)).toContain('targetStaggered');
    expect(full.frames[1]!.problems).toEqual([]);

    const none = run(steps, { target: { ...rhodagn, staggerNodes: [] } }, team);
    expect(none.frames[1]!.problems.map((p) => p.code)).toContain('triggerMissing');
  });

  it("Liino's combo works only inside Vocalist Stance, which her ultimate replaces", () => {
    const team = ['Liino', 'Estella', 'Akekuri'];
    const reaction = 'Estella: BS > Akekuri: BS > Liino: CS';
    const inStance = run(`Liino: BS > ${reaction}`, {}, team).frames;
    expect(codes(inStance[0]!)).toContain('stanceEntered');
    expect(inStance[3]!.problems).toEqual([]);

    const outside = run(reaction, {}, team).frames[2]!;
    expect(outside.problems).toContainEqual({ code: 'triggerOutOfStance', operator: 'Liino', stance: 'Vocalist Stance' });

    const replaced = run(`Liino: BS > ULT > ${reaction}`, {}, team).frames[4]!;
    expect(replaced.problems.map((p) => p.code)).toContain('triggerOutOfStance');
  });

  it("Arclight's combo opens on Electrification and again when it is consumed", () => {
    const team = ['Arclight', 'Perlica', 'Zhuang Fangyi'];
    // The pause lets her cooldown run out first: a trigger while the button
    // is grey lights nothing (#72).
    const frames = run('Perlica: FS > CS > Arclight: CS > Perlica: WAIT 4s > Zhuang Fangyi: BS > Arclight: CS', {}, team).frames;
    expect(frames[2]!.problems).toEqual([]);
    expect(frames[5]!.problems).toEqual([]);
    expect(frames[5]!.verdicts.get('6:trigger')).toEqual({
      code: 'triggerOpenedBy',
      by: [{ term: 'Electrification', step: 5 }],
    });
  });

  it("Da Pan's combo waits for 4 Vulnerability stacks: «reaches 4 stacks of» is a threshold", () => {
    expect(run('Da Pan: BS > CS').frames[1]!.problems).toContainEqual({
      code: 'triggerMissing',
      terms: [{ term: 'Vulnerable', min: 4 }],
      consumed: false,
    });
  });

  it("the Endministrator's combo opens on another operator's combo, never on its own", () => {
    const endmin = 'Endministrator (female)';
    const open = (frame: { combos: Array<{ key: string }> }) => frame.combos.some((combo) => combo.key === endmin);
    const idle = run('Endministrator (female): BA > BA', {}, [endmin, 'Chen Qianyu']);
    expect(idle.frames.some(open)).toBe(false);
    expect(run('Endministrator (female): CS', {}, [endmin]).frames[0]!.problems.map((p) => p.code)).toContain(
      'triggerMissing',
    );

    const answered = run('Chen Qianyu: BS > CS > Endministrator (female): CS', {}, ['Chen Qianyu', endmin]);
    expect(open(answered.frames[1]!)).toBe(true);
    expect(answered.frames[2]!.problems).toEqual([]);
    expect(open(answered.frames[2]!)).toBe(false);
  });

  it('a trigger nothing could be parsed from is unread, not always open', () => {
    const ember = run('Ember: BA > BA', {}, ['Ember']);
    expect(ember.frames.some((frame) => frame.combos.some((combo) => combo.key === 'Ember'))).toBe(false);
    const cast = run('Ember: CS', {}, ['Ember']).frames[0]!;
    expect(cast.problems).toEqual([]);
    expect(cast.verdicts.get('1:trigger')).toEqual({ code: 'triggerUnread' });
  });

  it("Typhoeus's «max Signs» is her own counter: unread, not searched for on the target", () => {
    const cast = run('Typhoeus: BS > CS', {}, ['Typhoeus']).frames[1]!;
    expect(cast.problems).toEqual([]);
    expect(cast.verdicts.get('2:trigger')).toEqual({ code: 'triggerUnread', own: 'Sign' });
  });

  it('BA > FS is one chain; an FS alone walks the whole chain', () => {
    const basic = data.sp!.basicAttack!['Chen Qianyu']!;
    const cycle = basic.sequenceSeconds!;
    const last = basic.finalStrikeSeconds!;
    const lengths = (text: string) => run(text).frames.map((frame) => frame.duration);

    expect(lengths('Chen Qianyu: BA > FS')).toEqual([cycle - last, last]);
    expect(lengths('Chen Qianyu: FS')).toEqual([cycle]);
    // A teammate's skill is cast from the controlled operator: the chain goes on.
    const across = run('Chen Qianyu: BA > Lifeng: BS > Chen Qianyu: FS', {}, ['Chen Qianyu', 'Lifeng']);
    expect(across.frames[2]!.chained).toBe(true);
    // A dodge keeps the chain: the client's dodge window leads into the next
    // hit, and a dash on the Final Strike's wind-up keeps it (measurements, #42).
    const dodged = run('Chen Qianyu: BA > DODGE > FS');
    expect(dodged.frames[2]!.chained).toBe(true);
    expect(dodged.frames[2]!.duration).toBe(last);
    // A pause — running or standing — restarts it.
    const paused = run('Chen Qianyu: BA > WAIT 2s > FS');
    expect(paused.frames[2]!.chained).toBe(false);
    expect(paused.frames[2]!.duration).toBe(cycle);
  });

  it('Link stands on the team until the next Battle Skill spends it, +30 % for one', () => {
    const result = run('Lifeng: BS > FS > CS > Chen Qianyu: BS');
    expect(result.frames[2]!.links.map((link) => link.term)).toEqual(['Link']);
    expect(result.frames[2]!.target.debuffs.some((debuff) => debuff.term === 'Link')).toBe(false);
    expect(result.frames[3]!.link).toEqual({ count: 1, bonus: 0.3 });
    expect(result.frames[3]!.links).toEqual([]);
  });

  it("Lifeng's additional ultimate hit lands only when the ultimate spends Link", () => {
    const ult = data.operators.Lifeng!.skills.find((skill) => skill.type === 'Ultimate')!;
    const labels = (consumed: string[]) =>
      stepHits(ult, { kind: 'ULT', sequence: null }, { consumed: new Set(consumed) }).map((hit) => hit.row.label);
    expect(labels([])).not.toContain('Additional ATK DMG Multiplier');
    expect(labels(['Link'])).toContain('Additional ATK DMG Multiplier');
  });

  it("Lifeng's ultimate knocks down twice: two Vulnerable stacks from one cast", () => {
    // «applies Knock Down … one more hit that … applies another Knock Down».
    const result = run('Lifeng: ULT', { ultimatesCharged: true });
    expect(result.frames[0]!.target.vulnerable).toBe(2);
    expect(result.frames[0]!.status.filter((event) => event.term === 'Knock Down').length).toBe(2);
  });

  it("the SP bar stands still through an ultimate's cutscene and does not fall back after it", () => {
    // SP below the cap, then the Endministrator's ultimate: the gauge holds
    // through the cutscene (#35, L5), so reading it mid-cutscene gives the
    // value at the press — not regen that the end of the ultimate takes back.
    const result = run('Chen Qianyu: BS > Endministrator (female): ULT', { ultimatesCharged: true }, ['Chen Qianyu', 'Endministrator (female)']);
    const ult = result.frames[1]!;
    const at = (t: number) => spAt(result.spTimeline, t, result.regen);
    expect(at(ult.world + ult.duration / 2)).toBeCloseTo(at(ult.world), 6);
    expect(at(ult.world + ult.duration)).toBeCloseTo(at(ult.world), 6);
  });

  it("Pogranichnik's battle skill recovers SP for the stacks its late hit eats, at the hit", () => {
    // His Breach lands 1.42 s after the press, inside the Endministrator's chain:
    // the stack is eaten there, and «SP Recovery by Consuming 1 Vulnerability
    // Stack» with it — not lost because the step running then is someone else's.
    const result = run('Chen Qianyu: BS > Pogranichnik: BS > Endministrator (female): BA', {}, ['Chen Qianyu', 'Pogranichnik', 'Endministrator (female)']);
    const skill = data.operators.Pogranichnik!.skills.find((item) => item.type === 'Battle Skill')!;
    const row = skill.stats.find((item) => item.sp?.when === 'consumed' && item.sp.stacks === 1)!;
    const level = teamOf(data, ['Pogranichnik'], []).get('Pogranichnik')!.skills.battle;
    const expected = row.values[level - 1]!;
    const landed = result.frames[2]!;
    expect(landed.verdicts.get(`3:spRecoveredBy:Pogranichnik`)).toMatchObject({ code: 'spRecoveredFor', sp: expected });
    expect(landed.spRecoveredBy.Pogranichnik).toBe(expected);
    // On the gauge at the hit, not at the start of the step it falls in.
    const hit = landed.status.find((event) => event.term === 'Breach')!.at!;
    const before = spAt(result.spTimeline, hit - 0.01, result.regen);
    const after = spAt(result.spTimeline, hit + 0.01, result.regen);
    expect(after - before).toBeGreaterThan(expected - 0.5);
  });

  it('a Physical Status breaks the crystals; the shards are the Endministrator’s', () => {
    const result = run('Endministrator (female): CS > Chen Qianyu: BS');
    const seal = result.frames[0]!.target.debuffs.find((debuff) => debuff.term === 'Originium Crystal');
    // The crystals last as long as the seal: «Seal Duration (s)», 5 s at level 12,
    // of timer — her own combo's slowdown stretches it (#70).
    expect(seal?.expiresAt).toBeCloseTo(timerEnd(result.frames[0]!.dilations ?? [], 0, 5), 6);
    // Her combo applies the crystals, not Vulnerable: «applying … shatters» is a condition.
    expect(result.frames[0]!.target.vulnerable).toBe(0);

    const broke = result.frames[1]!.status.find((event) => event.term === 'Originium Crystal');
    expect(broke).toMatchObject({ kind: 'debuffConsumed', by: 'Endministrator (female)', consumer: 'Chen Qianyu' });
    expect(result.frames[1]!.target.debuffs.some((debuff) => debuff.term === 'Originium Crystal')).toBe(false);
  });

  it('a Final Strike does not break the crystals (measurements, #10); the ultimate does', () => {
    const strike = run('Endministrator (female): CS > FS');
    expect(strike.frames[1]!.target.debuffs.some((debuff) => debuff.term === 'Originium Crystal')).toBe(true);

    const ult = run('Endministrator (female): CS > ULT');
    const event = ult.frames[1]!.status.find((item) => item.term === 'Originium Crystal');
    expect(event).toMatchObject({ kind: 'debuffConsumed', consumer: 'Endministrator (female)' });
  });

  it("the Endministrator's P1 returns 50 SP when her battle skill takes the crystals", () => {
    const spOnConsume = [{ term: 'Originium Crystal', skillType: 'Battle Skill' as const, sp: 50 }];
    const modifiers = { 'Endministrator (female)': { spOnConsume } };
    const own = run('Endministrator (female): CS > BS', { modifiers });
    expect(codes(own.frames[1]!)).toContain('spReturned');
    // Broken by somebody else, the return does not happen.
    const other = run('Endministrator (female): CS > Chen Qianyu: BS', { modifiers });
    expect(codes(other.frames[1]!)).not.toContain('spReturned');
  });

  it("Pogranichnik's combo slashes as many times as stacks were consumed", () => {
    // Chen's Lift: one stack on a clean target, then a second.
    const two = run('Chen Qianyu: BS > BS > Pogranichnik: BS > CS');
    expect(two.frames[3]!.moves).toBe(2);
    expect(two.frames[3]!.enhanced).toBe(false);
    const recovery = (sequence: number) =>
      data.operators.Pogranichnik!.skills
        .find((skill) => skill.type === 'Combo Skill')!
        .stats.find((row) => row.label === `SEQ ${sequence} SP Recovery`)!.values[11]!;
    expect(two.frames[3]!.spRecovered).toBeCloseTo(recovery(1) + recovery(2), 6);
  });

  it('a stage that is a hit of one press plays as the whole skill, and says so', () => {
    const result = run('Lifeng: BS1');
    expect(result.frames[0]!.step.sequence).toBeNull();
    expect(codes(result.frames[0]!)).toContain('stagesAreHits');
  });

  it('a pause takes exactly its seconds and regenerates SP; a perfect dodge gives SP', () => {
    const pause = run('Chen Qianyu: BS > WAIT 2.5s');
    expect(pause.frames[1]!.duration).toBe(2.5);
    expect(pause.frames[1]!.problems).toEqual([]);
    const dodge = run('Chen Qianyu: BS > DODGE');
    const gain = data.sp?.perfectDodge?.sp ?? 0;
    expect(gain).toBeGreaterThan(0);
    expect(dodge.frames[1]!.sp - dodge.frames[0]!.sp).toBeCloseTo(gain + (dodge.frames[0]!.duration * 8), 6);
  });

  it('WAIT, DODGE and an empty slot survive the text round trip', () => {
    const text = 'team: Lifeng, -, -, Endministrator (female)\nultimates: charged\nLifeng: WAIT 1.5s > DODGE\n';
    const rotation = parseRot(text, aliases);
    expect(rotation.team).toEqual(['Lifeng', '', '', 'Endministrator (female)']);
    expect(rotation.ultimatesCharged).toBe(true);
    expect(rotation.steps.map((step) => [step.kind, step.seconds ?? null])).toEqual([
      ['WAIT', 1.5],
      ['DODGE', null],
    ]);
    const back = parseRot(formatRot(rotation, (key) => key), aliases);
    expect(back.team).toEqual(rotation.team);
    expect(back.steps.map((step) => step.seconds ?? null)).toEqual([1.5, null]);
  });

  it('an empty slot keeps the positions after it', () => {
    const team = teamOf(data, ['Lifeng', '', '', 'Endministrator (female)']);
    expect(slotOrder(team)).toEqual(['Lifeng', '', '', 'Endministrator (female)']);
  });

  it('a charged start gives every operator exactly one ultimate', () => {
    const result = run('Chen Qianyu: ULT', { ultimatesCharged: true });
    expect(result.frames[0]!.problems).toEqual([]);
    const chen = teamOf(data, ['Chen Qianyu']).get('Chen Qianyu')!;
    expect(ultimateCost(chen)).toBeGreaterThan(0);
  });

  it("a Final Strike staggers by the number in the basic attack's text, the chain before it does not", () => {
    const chen = data.operators['Chen Qianyu']!.skills.find((skill) => skill.type === 'Basic Attack')!;
    expect(chen.text).toContain(`Final Strike also deals ${chen.finalStrikeStagger} Stagger`);
    const target = { name: 'boss', staggerMeter: 1000, staggerRecovery: 10, finisherMultiplier: 1, finisherSp: 0 };
    const result = run('Chen Qianyu: BA > FS', { target });
    expect(result.frames[0]!.target.stagger).toBe(0);
    expect(result.frames[1]!.target.stagger).toBe(chen.finalStrikeStagger);
  });

  it('control follows the track: who attacks, who takes it with an ultimate, and who starts with it', () => {
    const order = ['Lifeng', 'Chen Qianyu', 'Laevatain'];
    const played = run('Chen Qianyu: BS > Lifeng: BA > Chen Qianyu: CS > Laevatain: ULT', {}, order);
    // Nobody named: the first one to attack starts with control.
    expect(played.controlled).toBe('Lifeng');
    expect(played.frames.map((frame) => frame.controlled)).toEqual(['Lifeng', 'Lifeng', 'Lifeng', 'Laevatain']);

    const chosen = run('Chen Qianyu: BS > Lifeng: BA', { controlled: 'Chen Qianyu' }, order);
    expect(chosen.frames.map((frame) => frame.controlled)).toEqual(['Chen Qianyu', 'Lifeng']);
    // Someone outside the squad cannot be controlled; no attacks — slot 01.
    expect(run('Chen Qianyu: BS', { controlled: 'Mi Fu' }, order).controlled).toBe('Lifeng');
  });

  it('`controlled:` survives the text round trip', () => {
    const rotation = parseRot('team: Lifeng, Chen Qianyu\ncontrolled: Chen Qianyu\nLifeng: BS', aliases);
    expect(rotation.controlled).toBe('Chen Qianyu');
    expect(parseRot(formatRot(rotation, (key) => key), aliases).controlled).toBe('Chen Qianyu');
  });
});
