/**
 * Damage on the track: what each step deals, the total and damage per second.
 *
 * Per-hit numbers come from `analyse`, the very function behind the build
 * editor's damage table. A second damage path for the track would drift from
 * the editor on the first patch.
 *
 * Which rows a step deals is `stepHits`, and what a row *is* was decided
 * once in `export.py`. This module only adds them up — and keeps an honest
 * list of what the sum leaves out, because a big total with no caveats reads
 * as more certain than it is.
 *
 * Buffs come from `trackBuffs`: what hangs on each step, on whom. A step is
 * computed with the buffs standing at its start, through the same `analyse`
 * — the sheet is rebuilt only when that set changes.
 *
 * Stagger follows the same rule: a step's hits and statuses take the
 * Staggered +30 % when the target was staggered as the step began
 * (`Frame.staggeredAtStart`). The state is checked per hit (#45): when the
 * cast's first hit fills the meter (`Frame.brokenByFirstHit`), that hit goes
 * without the bonus and the rest of the step with it; a step that fills it
 * with its stagger as a whole gets none. A finisher gets it, on top of the
 * enemy's Finisher ATK Mult (#45: Chen's 67,831 on Rhodagn).
 *
 * Susceptibility and Amp a skill puts up itself (Lifeng's battle skill,
 * Si's ultimate) come from `grantBuffs` and follow the status debuffs'
 * timing.
 */

import { analyse, rowId, type Build, type BuildAnalysis } from './build.js';
import { castMatches, trackBuffs, type ActiveBuff } from './buffs.js';
import type { Bundle, Element, Skill, SkillType, StatRow } from './bundle.js';
import { grantBuffs } from './grants.js';
import { stepHits } from './hits.js';
import type { Message } from './messages.js';
import { skillTypeOf, statAt, warp, type Frame, type Target } from './simulate.js';
import { statusDamage, statusDebuffs, statusHits } from './statusHits.js';

export interface DamagePart {
  /** The skill row, with its count: «Slash Multiplier × 6», «Breach SL 2». */
  label: string;
  /** Expected damage: non-crit × (1 + crit rate × crit damage). */
  damage: number;
  /** The same hit without crit: what a damage number in the game shows. */
  nonCrit: number;
  stacks?: number;
  /** Whose damage it is: a status counts for whoever applied it. */
  by: string;
  status?: boolean;
}

export interface StepDamage {
  total: number;
  parts: DamagePart[];
  /** Buffs and target debuffs this step was computed with, repeats included. */
  buffs: ActiveBuff[];
  /** The Link this step spent, if any. */
  link: { count: number; bonus: number } | null;
}

/** A caveat on the sum; `operator` — whose build it is about. */
const SKILL_LEVEL: Record<SkillType, keyof Build['skills']> = {
  'Basic Attack': 'basic',
  'Battle Skill': 'battle',
  'Combo Skill': 'combo',
  Ultimate: 'ultimate',
};

export interface NotCounted {
  operator?: string;
  message: Message;
}

export interface TrackDamage {
  /** Aligned with the frames. */
  steps: StepDamage[];
  /** What stands during each step, after its own triggers. Aligned with the frames. */
  standing: ActiveBuff[][];
  total: number;
  /** Over the whole track length, waiting included. */
  dps: number;
  /** In the order of `team`. */
  byOperator: Array<{ key: string; damage: number }>;
  /** What the numbers leave out. Shown next to them, always. */
  notCounted: NotCounted[];
}

/** A simulated variant, as much of it as the damage needs. */
export interface TrackRun {
  frames: Frame[];
  /** Total seconds, waits included: `SimulationResult.real`. */
  length: number;
  /** Operator keys, team-position order. */
  team: string[];
  /** What it was played against: the dummy's finisher multiplier comes from here. */
  target?: Target;
}

/**
 * Order inside one cast, from the measurements (#23): the first move hits
 * with the buffs standing at the start of the step; the status it applies
 * hits with what that move switched on (Thermite Cutter after the SP
 * refund); a later move of the same cast also gets the status's own debuff
 * (SEQ 2 on its own Breach). Steps written as separate moves (`BS1 > BS2`)
 * follow the plain next-step rule instead.
 */
export function trackDamage(
  bundle: Bundle,
  run: TrackRun,
  buildOf: (key: string) => Build,
  enemyKey: string | null,
): TrackDamage {
  const { frames, length } = run;
  // No assumed stacks: the track decides what is up, step by step.
  const finisher = run.target && !(enemyKey && bundle.enemies[enemyKey]) ? { finisherMultiplier: run.target.finisherMultiplier } : {};
  const dummyAt = (staggered: boolean) => ({ enemyKey, tier: 5, staggered, crit: false, assume: {}, ...finisher });
  const dummy = dummyAt(false);
  const enemy = enemyKey ? bundle.enemies[enemyKey] : null;
  const bare = new Map<string, BuildAnalysis>();
  for (const key of run.team) {
    const analysis = analyse(buildOf(key), bundle, dummy);
    if (analysis) bare.set(key, analysis);
  }
  const holders = [...bare].map(([key, analysis]) => ({ key, active: analysis.effects.active, critRate: analysis.sheet.critRate }));
  let buffs = trackBuffs(frames, holders);
  /** One operator under one set of buffs, on a staggered target or not: analysed once, then reused. */
  const analyses = new Map<string, BuildAnalysis>();
  const under = (key: string, standing: ActiveBuff[], staggered: boolean) => {
    const mine = standing.filter((buff) => buff.receiver === key || buff.receiver === 'enemy');
    const signature = `${key}|${staggered}|${mine.map(buffSignature).sort().join(',')}`;
    let analysis = analyses.get(signature);
    if (!analysis) {
      analysis =
        mine.length > 0 || staggered
          ? (analyse(buildOf(key), bundle, dummyAt(staggered), mine) ?? undefined)
          : bare.get(key);
      if (!analysis) return null;
      analyses.set(signature, analysis);
    }
    const rate = Math.min(1, Math.max(0, analysis.sheet.critRate));
    // Statuses take the sheet's crit damage; a skill row its own (Rossi's ultimate).
    const crit = 1 + rate * analysis.sheet.critDmg;
    const byId = new Map(analysis.skills.map((row) => [row.id, row.result.damage]));
    const critDmgById = new Map(analysis.skills.map((row) => [row.id, row.critDmg]));
    const critOf = (id: string): number => 1 + rate * (critDmgById.get(id) ?? analysis.sheet.critDmg);
    /** The same row fired with extra crit on top: Yvonne's stacks inside her own ultimate. */
    const critWith = (id: string, extraRate: number, extraDmg: number): number =>
      1 + Math.min(1, Math.max(0, analysis.sheet.critRate + extraRate)) * ((critDmgById.get(id) ?? analysis.sheet.critDmg) + extraDmg);
    return { analysis, mine, crit, critOf, critWith, byId };
  };

  /**
   * A barrage ultimate's crit stacks (`Skill.barrage`): what one row is worth
   * against its non-crit damage. The shot row takes each shot's own stacks
   * from the ramp; the closing strike and the extra attack come after the
   * last shot, at `finalStacks`.
   */
  const barrageCrit = (table: NonNullable<ReturnType<typeof under>>, skill: Skill, level: number, label: string): number => {
    const barrage = skill.barrage!;
    const id = rowId(skill, label);
    if (!barrage.stack) return table.critOf(id);
    const perStack = statAt(skill, barrage.stack.rate, level) ?? 0;
    const max = statAt(skill, barrage.stack.max, level) ?? Infinity;
    const atMax = barrage.stack.atMax ? (statAt(skill, barrage.stack.atMax, level) ?? 0) : 0;
    const at = (stacks: number): number => table.critWith(id, stacks * perStack, stacks >= max ? atMax : 0);
    if (label !== barrage.row) return at(barrage.finalStacks);
    const shots = barrage.ramp.reduce((sum, [, count]) => sum + count, 0);
    return shots > 0 ? barrage.ramp.reduce((sum, [stacks, count]) => sum + count * at(stacks), 0) / shots : table.critOf(id);
  };

  // A charge the ultimate set off (Fluorite's explosive): its hit moves from
  // the planting step to the detonating one.
  const detonatedAt = new Map<number, number>();
  frames.forEach((frame, index) => {
    if (frame.detonated) detonatedAt.set(frame.detonated.step, index);
  });
  const fused = new Set<string>();

  // A status debuff scales with its applier's Arts Intensity as they stood
  // at the step that applied it — the same sheet its own hit uses — and
  // keeps that strength while it stands (measurements, #46). The enemy's
  // debuffs do not touch Arts Intensity, so the applier's own buffs are enough.
  const appliedAt = new Map<string, number>();
  frames.forEach((frame, index) => {
    for (const debuff of frame.target.debuffs) {
      const id = `${debuff.term}|${debuff.source}|${debuff.appliedAt}`;
      if (!appliedAt.has(id) && Math.abs(debuff.appliedAt - frame.world) < 1e-9) appliedAt.set(id, index);
    }
  });
  const debuffs = statusDebuffs(frames, (debuff) => {
    const index = appliedAt.get(`${debuff.term}|${debuff.source}|${debuff.appliedAt}`);
    const applier = index == null ? null : under(debuff.source, buffs.after[index] ?? [], false);
    const sheet = applier?.analysis ?? bare.get(debuff.source);
    return {
      artsIntensity: sheet?.sheet.artsIntensity ?? 0,
      reactionMax: sheet?.effects.modifiers.reactionMax ?? {},
    };
  });
  const plainStatuses = statusHits(frames, length);
  // An extra hit an effect performs (Swordmancer's 250 % ATK) lands with the
  // step that fired it and is computed like a status hit: no skill-type bonus.
  const withExtra = (timeline: typeof buffs) => {
    const out = plainStatuses.map((list) => [...list]);
    for (const hit of timeline.extraHits) {
      out[hit.frameIndex]?.push({ name: hit.name, kind: 'skill', multiplier: hit.multiplier, element: hit.element, by: hit.by, statusLevel: 0 });
    }
    return out;
  };
  let statuses = withExtra(buffs);
  const grants = grantBuffs(bundle, frames, run.team, (key) => {
    const sheet = bare.get(key)?.sheet;
    if (!sheet) return null;
    const { basic, battle, combo, ultimate } = buildOf(key).skills;
    return {
      skills: { 'Basic Attack': basic, 'Battle Skill': battle, 'Combo Skill': combo, Ultimate: ultimate },
      attributes: sheet.attributes,
      mods: bare.get(key)!.effects.active.flatMap((effect) => effect.grants ?? []),
    };
  });

  const conditional: Array<{ operator: string; label: string }> = [];
  const variable: Array<{ operator: string; label: string }> = [];
  const note = (list: typeof conditional, operator: string, label: string): void => {
    if (!list.some((row) => row.operator === operator && row.label === label)) list.push({ operator, label });
  };
  /** Who stands after frame `at`, for a hit landing then: the step's own `standing`. */
  const standingAfter = (at: number) => {
    const frame = frames[at]!;
    const list = [
      ...(buffs.after[at] ?? []),
      ...(debuffs.before[at] ?? []),
      ...(debuffs.fresh[at] ?? []),
      ...(grants.before[at] ?? []),
      ...(grants.fresh[at] ?? []),
    ];
    return { list, staggered: frame.target.staggered };
  };
  /**
   * Instances of a row that land after a later press, by the frame they land
   * in: its hit times (`hit.at`, `export.py`) from this press, against the
   * presses after it. A chain row counts from the chain's start, and lands
   * with the segment's last hit. A move's rows and a `BA3` have no times.
   */
  const landingFrames = (
    index: number,
    frame: Frame,
    row: StatRow,
    move: string | null,
    times: number,
  ): Map<number, number> => {
    const out = new Map<number, number>();
    const offsets = hitOffsets(bundle, frame, row, move, times);
    if (!offsets) return out;
    for (const offset of offsets) {
      const t = frame.world + offset;
      let landed = index;
      // A press at the very moment of the hit comes after it: the hit opened it.
      while (landed + 1 < frames.length && frames[landed + 1]!.world < t - 1e-6) landed += 1;
      if (landed !== index) out.set(landed, (out.get(landed) ?? 0) + 1);
    }
    return out;
  };

  const computeSteps = (): StepDamage[] => frames.map((frame, index) => {
    const key = frame.step.actor;
    const operator = key ? bundle.operators[key] : undefined;
    // A transformed battle skill plays the rows of the skill it is treated as
    // (Camille's Hunter Pursuit); an enhanced basic attack, the ultimate's (Laevatain's).
    const type = frame.transformed?.as ?? (frame.enhancedBasic ? 'Ultimate' : skillTypeOf(frame.step.kind));
    const move = frame.transformed?.into ?? frame.enhancedBasic?.move ?? frame.duringUltimate ?? null;
    const skill = type ? operator?.skills.find((item) => item.type === type) : undefined;
    if (!key || !bare.has(key) || !skill || frame.problems.some((problem) => problem.code === 'notInTeam')) {
      return { total: 0, parts: [], buffs: [], link: null };
    }
    const standingDebuffs = [...(debuffs.before[index] ?? []), ...(grants.before[index] ?? [])];
    const before = [...(buffs.frames[index] ?? []), ...standingDebuffs];
    const after = [...(buffs.after[index] ?? []), ...standingDebuffs];
    // «After hitting an enemy with skills» lands after the cast's statuses:
    // Chen's Lift and Swordmancer hit came with her ATK before the new
    // talent stack (measurements, #60). Such a buff keeps its standing
    // before the step for them.
    const onHit = (buff: ActiveBuff) => (buff.apply.trigger ?? '').split('|').some((trigger) => trigger.trim() === 'skill_hit');
    const settled = after.flatMap((buff) => {
      if (!onHit(buff)) return [buff];
      const was = before.find((standing) => standing.effect.id === buff.effect.id && standing.apply === buff.apply && standing.receiver === buff.receiver);
      return was ? [was] : [];
    });
    const later = [...settled, ...(debuffs.fresh[index] ?? []), ...(grants.fresh[index] ?? [])];
    const staggered = frame.staggeredAtStart;
    // The cast's first hit filled the meter: that hit goes without the +30 %,
    // everything after it in the step with it (measurements, #45).
    const afterBreak = staggered || frame.brokenByFirstHit === true;
    // A buff the cast switches on by applying something reaches the hit
    // that applied it when the cast is one hit: Grizzled Edge's +6 % ×
    // consumed Vulnerable, fired by the Crush of her one-hit battle skill,
    // was in that hit (measurements, #61). In a cast of several moves the
    // first one comes before the application (Pogranichnik's SEQ 1, #23).
    const sequences = new Set(
      skill.stats.filter((row) => (row.move ?? null) === move && row.hit?.role === 'hit').map((row) => row.hit?.sequence ?? 0),
    );
    const onApply =
      sequences.size <= 1
        ? (buffs.after[index] ?? []).filter(
            (buff) =>
              buff.receiver === key &&
              (buff.apply.trigger ?? '').split('|').some((trigger) => trigger.trim().startsWith('applies:')) &&
              !before.some((standing) => standing.effect.id === buff.effect.id && standing.apply === buff.apply),
          )
        : [];
    const first = under(key, [...before, ...onApply], staggered)!;
    const firstAfter = under(key, [...before, ...onApply], afterBreak)!;
    const rest = under(key, later, afterBreak)!;
    // A barrage is one long cast: what stood at its start, plus what the cast
    // itself switched on (Yvonne's P5). What it consumes, it consumes with the
    // closing strike, so the shots still see it.
    const whole = frame.step.kind === 'ULT' && skill.barrage ? under(key, spanning(before, later), afterBreak)! : null;
    /** The hit that broke the meter is still to come: the first instance of the first row. */
    let opening = frame.brokenByFirstHit === true;

    for (const row of skill.stats) {
      if ((row.move ?? null) !== move) continue;
      // A row with a `when` is decided per step; only the ones nobody can decide are listed.
      if (row.hit?.role === 'conditional' && !row.hit.when) note(conditional, key, row.label);
    }
    // What this cast itself took: the Link it spent, the crystals it broke.
    const consumed = new Set(
      frame.status
        .filter(
          (event) =>
            ((event.kind === 'debuffConsumed' || event.kind === 'reactionConsumed') && event.consumer === key) ||
            (event.kind === 'buffSpent' && event.by === key),
        )
        .map((event) => event.term),
    );
    const link = 1 + (frame.link?.bonus ?? 0);
    const parts: DamagePart[] = [];
    const push = (part: Omit<DamagePart, 'damage'>, crit: number): void => {
      parts.push({ ...part, damage: part.nonCrit * crit });
    };
    const context = {
      consumed,
      moves: frame.moves,
      enhanced: frame.enhanced,
      chained: frame.chained,
      move,
      made: frame.stock?.made ?? null,
      // The target as the cast found it: the frame before, minus what had run out.
      targetHas: (term: string) =>
        (frames[index - 1]?.target.debuffs ?? []).some(
          (debuff) => debuff.term === term && (debuff.expiresAt == null || debuff.expiresAt > frame.world + 1e-9),
        ),
    };
    const barrage = frame.step.kind === 'ULT' ? skill.barrage : undefined;
    const ownLevel = buildOf(key).skills[SKILL_LEVEL[skill.type]] ?? 1;
    const planted = frame.step.kind === 'BS' && Object.values(bundle.synergy.detonates?.[key] ?? {}).some((entry) => entry.skill === skill.name);
    if (planted && !detonatedAt.has(frame.step.index)) fused.add(key);
    for (const hit of stepHits(skill, frame.step, context)) {
      // The explosion went off later, at the ultimate that detonated it.
      if (planted && detonatedAt.has(frame.step.index)) break;
      const id = rowId(skill, hit.row.label);
      // A later move of one cast lands after the cast's own statuses; a
      // barrage fires after its own cast (Yvonne's P5 is up for it).
      const later = frame.step.sequence == null && (hit.row.hit?.sequence ?? 1) >= 2;
      const table = whole ?? (later ? rest : firstAfter);
      const critOf = (from: typeof table, row: string): number =>
        barrage ? barrageCrit(from, skill, ownLevel, hit.row.label) : from.critOf(row);
      // A row that swings several times (Chen's ult: six slashes) counts each.
      if (hit.count == null) note(variable, key, hit.row.label);
      let times = hit.count ?? 1;
      // Instances that land after a later press take what stands then (Я3):
      // the Endministrator's chain under the combo Chen pressed during it.
      if (!whole && hit.role !== 'perStack') {
        const elsewhere = landingFrames(index, frame, hit.row, move, times);
        for (const [at, count] of elsewhere) {
          // The cast's own view of its hit, moved to when the hit lands: what
          // ran out by then is gone, what later presses took off is gone, what
          // they put up is there. What the cast itself takes or switches on
          // stays as at its press: its consumption and its hit are one event
          // in the game (the crystals the Endministrator's ultimate shatters
          // still stand for its blow; the talent the shattering switches on
          // does not, measurements #2, #8).
          const standing = standingAfter(at);
          const t = frames[at]!.world;
          const pressed = new Set(standingAfter(index).list.map(identity));
          const there = new Set(standing.list.map(identity));
          // «Next cast» buffs the cast spends: the track drops them a step late (Grand Vision).
          const spent = (buff: ActiveBuff) =>
            buff.apply.spentBy != null && buff.source === key && castMatches(buff.apply.spentBy, frame);
          const base = [...before, ...onApply];
          const known = new Set(base.map(identity));
          const kept = base.filter(
            (buff) =>
              (buff.until == null || buff.until > t + 1e-9) &&
              (spent(buff) || !pressed.has(identity(buff)) || there.has(identity(buff))),
          );
          const added = standing.list.filter((buff) => !pressed.has(identity(buff)) && !known.has(identity(buff)));
          const then = under(key, [...kept, ...added], standing.staggered);
          if (!then) continue;
          const label = `${hit.row.label} × ${count} (${frames[at]!.world.toFixed(1)} s)`;
          push({ label, nonCrit: (then.byId.get(id) ?? 0) * count * link, by: key }, critOf(then, id));
          times -= count;
        }
        if (times <= 0) continue;
      }
      if (opening && hit.role !== 'perStack' && !later && !whole) {
        // The breaking hit itself, before the +30 %.
        opening = false;
        push({ label: `${hit.row.label} × 1`, nonCrit: (first.byId.get(id) ?? 0) * link, by: key }, critOf(first, id));
        times -= 1;
        if (times <= 0) continue;
      }
      const one = (table.byId.get(id) ?? 0) * times;
      const label = times > 1 || (hit.count != null && hit.count > 1) ? `${hit.row.label} × ${times}` : hit.row.label;
      if (hit.role === 'perStack') {
        if (frame.stacksForHit > 0) {
          push({ label, nonCrit: one * frame.stacksForHit * link, stacks: frame.stacksForHit, by: key }, critOf(table, id));
        }
      } else {
        push({ label, nonCrit: one * link, by: key }, critOf(table, id));
      }
    }

    // The charge this ultimate set off: the battle skill's hit at its own
    // level, times the ultimate's increase — a separate multiplier in the
    // client (`ProdCalcZone`, measurements #53) — under this step's buffs.
    if (frame.detonated) {
      const planter = operator!.skills.find((item) => item.name === frame.detonated!.skill);
      const boost = statAt(skill, frame.detonated.boost, ownLevel) ?? 0;
      for (const hit of planter ? stepHits(planter, { kind: 'BS', sequence: null }) : []) {
        const id = rowId(planter!, hit.row.label);
        const one = (first.byId.get(id) ?? 0) * (hit.count ?? 1);
        push({ label: `${planter!.name}: ${hit.row.label} × ${(1 + boost).toFixed(2)}`, nonCrit: one * (1 + boost), by: key }, first.critOf(id));
      }
    }

    // Shards of somebody's crystals, broken at this step: the owner's hit, at
    // the owner's buffs before the break — the ATK talent comes after it
    // (measurements, #2, #8).
    for (const event of frame.status) {
      if (event.kind !== 'debuffConsumed' || !event.by) continue;
      const owner = bundle.operators[event.by];
      const at = owner && bare.has(event.by) ? under(event.by, before, afterBreak) : null;
      if (!owner || !at) continue;
      for (const ownSkill of owner.skills) {
        for (const row of ownSkill.stats) {
          if (row.hit?.role !== 'delayed' || row.hit.when !== `consumed:${event.term}`) continue;
          const id = rowId(ownSkill, row.label);
          push({ label: row.label, nonCrit: at.byId.get(id) ?? 0, by: event.by }, at.critOf(id));
        }
      }
    }

    // Points somebody's cast left, spent at this step: Pogranichnik's Harass on
    // the first four Steel Oath points, Decisive Assault instead on the last
    // (measurements, #47) — his hits, at his buffs before the step, like the
    // crystal shards above.
    for (const spent of frame.charges) {
      const owner = bundle.operators[spent.owner];
      const ownSkill = owner?.skills.find((item) => item.name === spent.skill);
      const at = ownSkill && bare.has(spent.owner) ? under(spent.owner, settled, afterBreak) : null;
      if (!ownSkill || !at) continue;
      for (const row of ownSkill.stats) {
        if (row.hit?.role !== 'delayed') continue;
        const lands = row.hit.when === `${spent.last ? 'chargeLast' : 'charge'}:${spent.name}`;
        const id = rowId(ownSkill, row.label);
        if (lands) push({ label: row.label, nonCrit: at.byId.get(id) ?? 0, by: spent.owner }, at.critOf(id));
      }
    }

    for (const hit of statuses[index] ?? []) {
      const owner = under(hit.by, settled, afterBreak);
      if (!owner) continue;
      const tier = enemy ? Math.min(dummy.tier, enemy.def.length - 1) : 0;
      const result = statusDamage(hit, {
        sheet: owner.analysis.sheet,
        target: owner.analysis.effects.assumed.target,
        amp: owner.analysis.effects.assumed.self.amp,
        operatorLevel: buildOf(hit.by).level,
        def: enemy ? (enemy.def[tier] ?? 100) : 100,
        resistance: enemy ? (enemy.resistances[hit.element as Element] ?? 1) : 1,
        staggered: afterBreak,
      });
      const ticks = hit.ticks ? `${hit.name} × ${hit.ticks} s${hit.scale != null ? ` × ${hit.scale}` : ''}` : null;
      const label = ticks ?? (hit.statusLevel > 0 ? `${hit.name} SL ${hit.statusLevel}` : hit.name);
      // Sunderization's explosion: +X % per point of its owner's Arts Intensity.
      const perAi = hit.aiPerPoint ? 1 + hit.aiPerPoint * owner.analysis.sheet.artsIntensity : 1;
      parts.push({ label, damage: result.expected * perAi, nonCrit: result.damage * perAi, by: hit.by, status: true });
    }

    return {
      total: parts.reduce((sum, part) => sum + part.damage, 0),
      parts,
      buffs: [...first.mine, ...rest.mine],
      link: frame.link ? { count: frame.link.count, bonus: frame.link.bonus } : null,
    };
  });
  let steps = computeSteps();
  // Crit triggers (Wolven Blood, MI Security) need the hits, and the hits are
  // only known once the steps are computed: a second pass with the expected
  // crits of the first. A crit-capable part is one crit raises (DoT does not).
  const critTriggered = holders.some((holder) =>
    holder.active.some((effect) => effect.apply.some((apply) => (apply.trigger ?? '').split('|').some((t) => t.trim() === 'crit'))),
  );
  if (critTriggered) {
    const hits = steps.map((step) => {
      const byHolder = new Map<string, number>();
      for (const part of step.parts) {
        if (part.damage <= part.nonCrit * (1 + 1e-9)) continue;
        const times = Number(/×\s*(\d+)\s*$/.exec(part.label)?.[1] ?? 1);
        byHolder.set(part.by, (byHolder.get(part.by) ?? 0) + times);
      }
      return byHolder;
    });
    buffs = trackBuffs(frames, holders, (index, key) => hits[index]?.get(key) ?? 0);
    statuses = withExtra(buffs);
    analyses.clear();
    steps = computeSteps();
  }

  const total = steps.reduce((sum, step) => sum + step.total, 0);
  const sums = new Map<string, number>();
  for (const step of steps) {
    for (const part of step.parts) sums.set(part.by, (sums.get(part.by) ?? 0) + part.damage);
  }

  const notCounted: NotCounted[] = [
    { message: { code: 'trackCorrosion' } },
    { message: { code: 'trackLink' } },
    { message: { code: 'trackNextStep' } },
    { message: { code: 'trackHitTimes' } },
    { message: { code: 'trackStatusSnapshot' } },
    { message: { code: 'trackStaggerAtStart' } },
    ...(grants.scaled ? [{ message: { code: 'trackGrantSnapshot' } as const }] : []),
    ...buffs.notes.map((message) => ({ message })),
  ];
  if (grants.uncounted.length > 0) notCounted.push({ message: { code: 'trackGrantUncounted', rows: grants.uncounted } });
  for (const [key, analysis] of bare) {
    if (analysis.effects.missing) notCounted.push({ message: { code: 'trackNoLayout', operator: key } });
  }
  if (conditional.length > 0) notCounted.push({ message: { code: 'trackConditional', rows: conditional } });
  if (variable.length > 0) notCounted.push({ message: { code: 'trackHitCount', rows: variable } });
  for (const key of new Set(frames.filter((frame) => frame.step.kind === 'ULT' && frame.step.actor && bare.has(frame.step.actor)).map((frame) => frame.step.actor!))) {
    const ultimate = bundle.operators[key]?.skills.find((item) => item.type === 'Ultimate');
    if (ultimate?.barrage) notCounted.push({ operator: key, message: { code: 'trackBarrage', operator: key } });
  }
  // Skills on the track whose rows were put on the last hit (`export.py`, `hit_times`).
  const guessed = new Set<string>();
  for (const frame of frames) {
    const key = frame.step.actor;
    const type = skillTypeOf(frame.step.kind);
    const skill = key && type && type !== 'Basic Attack' ? bundle.operators[key]?.skills.find((item) => item.type === type) : undefined;
    if (!key || !skill?.hitTimes || !frame.clientTimed || guessed.has(`${key}|${skill.name}`)) continue;
    guessed.add(`${key}|${skill.name}`);
    notCounted.push({ operator: key, message: { code: 'trackHitGuess', operator: key, skill: skill.name } });
  }
  for (const key of fused) {
    const entry = Object.values(bundle.synergy.detonates?.[key] ?? {})[0]!;
    notCounted.push({ operator: key, message: { code: 'trackFuse', operator: key, name: entry.name, fuse: entry.fuse } });
  }
  for (const [key, analysis] of bare) {
    for (const message of analysis.unaccounted) notCounted.push({ operator: key, message });
  }

  const standing = frames.map((_, index) => [
    ...(buffs.after[index] ?? []),
    ...(debuffs.before[index] ?? []),
    ...(debuffs.fresh[index] ?? []),
    ...(grants.before[index] ?? []),
    ...(grants.fresh[index] ?? []),
  ]);

  return {
    steps,
    standing,
    total,
    dps: length > 0 ? total / length : 0,
    byOperator: run.team.map((key) => ({ key, damage: sums.get(key) ?? 0 })),
    notCounted,
  };
}

/**
 * Buffs over a whole cast: by effect row and receiver, the side holding
 * more of them — the start for what the cast takes off, the end for what it
 * adds; on a tie the end, which has the newer stacks.
 */
function spanning(start: ActiveBuff[], end: ActiveBuff[]): ActiveBuff[] {
  const key = (buff: ActiveBuff) =>
    [buff.effect.id, buff.apply.stat, buff.apply.element ?? '', buff.apply.skillType ?? '', buff.receiver].join('|');
  const group = (list: ActiveBuff[]) => {
    const out = new Map<string, ActiveBuff[]>();
    for (const buff of list) out.set(key(buff), [...(out.get(key(buff)) ?? []), buff]);
    return out;
  };
  const [from, to] = [group(start), group(end)];
  const out: ActiveBuff[] = [];
  for (const id of new Set([...from.keys(), ...to.keys()])) {
    const a = from.get(id) ?? [];
    const b = to.get(id) ?? [];
    out.push(...(a.length > b.length ? a : b));
  }
  return out;
}

/**
 * When each of `times` instances of a damage row lands, seconds from the
 * step's press (`hit.at`, from the client's frames). A chain row counts from
 * the chain's start and lands with its segment's last hit; a Final Strike
 * that finishes the BA before it starts where that BA stopped. `null` — no
 * times: a nominal-second step, a move's rows, a `BA3` on its own.
 */
export function hitOffsets(bundle: Bundle, frame: Frame, row: StatRow, move: string | null, times: number): number[] | null {
  const key = frame.step.actor;
  const own = ownOffsets(bundle, frame, row, move, times);
  // A later combo's slowdown or a cutscene moves the hits of whoever it stops (#66).
  if (!own || !key || !frame.dilations?.length) return own;
  return own.map((offset) => warp(frame.dilations!, frame.world, offset, key) - frame.world);
}

function ownOffsets(bundle: Bundle, frame: Frame, row: StatRow, move: string | null, times: number): number[] | null {
  const at = row.hit?.at;
  const key = frame.step.actor;
  if (!at || at.length === 0 || move || !frame.clientTimed || !key) return null;
  if (row.hit?.part === 'chain') {
    if (frame.step.sequence != null) return null;
    const basic = bundle.sp?.basicAttack?.[key];
    const chained = frame.step.kind === 'FS' && frame.chained;
    if (chained && (basic?.sequenceSeconds == null || basic.finalStrikeSeconds == null)) return null;
    const start = chained ? basic!.sequenceSeconds! - basic!.finalStrikeSeconds! : 0;
    return Array.from({ length: times }, () => Math.max(0, at.at(-1)! - start));
  }
  return at.length === times ? at : Array.from({ length: times }, () => at.at(-1)!);
}

/** Seconds from the press to each hit of the step's own damage rows: ticks on the track. */
export function stepHitOffsets(bundle: Bundle, frame: Frame): number[] {
  const key = frame.step.actor;
  const type = frame.transformed || frame.enhancedBasic || frame.duringUltimate ? null : skillTypeOf(frame.step.kind);
  const skill = key && type ? bundle.operators[key]?.skills.find((item) => item.type === type) : undefined;
  if (!skill) return [];
  const out: number[] = [];
  const context = { chained: frame.chained, moves: frame.moves, enhanced: frame.enhanced, made: frame.stock?.made ?? null };
  for (const hit of stepHits(skill, frame.step, context)) {
    if (hit.role === 'perStack') continue;
    out.push(...(hitOffsets(bundle, frame, hit.row, null, hit.count ?? 1) ?? []));
  }
  return [...new Set(out.map((offset) => Math.round(offset * 1e4) / 1e4))].sort((a, b) => a - b);
}

/** One buff line on one receiver, whatever its stacks: is it still up. */
function identity(buff: ActiveBuff): string {
  const { apply } = buff;
  return [buff.effect.id, apply.stat, apply.element ?? '', apply.skillType ?? '', apply.trigger ?? '', buff.receiver].join('|');
}

function buffSignature(buff: ActiveBuff): string {
  const { apply } = buff;
  return [buff.effect.id, apply.stat, apply.element ?? '', apply.skillType ?? '', apply.value, buff.stacks, buff.scale].join(':');
}
