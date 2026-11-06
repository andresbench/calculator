/**
 * Turning a simulation into something drawable.
 *
 * The engine emits frames: one per step, each carrying the world clock, the
 * resources and the state of the target. A track is that same sequence read
 * geometrically — lanes down the side, time across.
 *
 * The one rule worth stating: **the ribbon is derived, never authored**. What
 * shows above the lanes — buff windows, Vulnerable stacks, which combo is
 * open — is read back out of the frames. Nothing in the interface can assert
 * a window the engine did not produce.
 */

import {
  CONTROLLED_KINDS,
  buildAliases,
  parseRot,
  reactionBonusFor,
  simModifiersFor,
  simulateVariant,
  ultimateCost,
  splitVariants,
  targetFor,
  teamFromRoster,
  type Build,
  type Bundle,
  type Frame,
  type Message,
  type Rotation,
  type RotStep,
  type SimModifiers,
  type Target,
  type TeamMember,
} from '@engine/index.js';

export interface TrackLane {
  key: string;
  /** Team position, from 1. The game reads it — see `TeamMember`. */
  slot: number;
  name: string;
  icon: string | null;
  element: string;
  frames: Frame[];
  /** Energy the ultimate costs, potentials included: the lane's charge bar fills to it. */
  ultCost: number;
  /** Energy at the start: the cost when the fight starts charged, else 0. */
  startEnergy: number;
}

export interface RibbonSpan {
  term: string;
  from: number;
  /** `null` means the wiki does not give a duration — drawn as a marker. */
  to: number | null;
  /** Step index that put it there, so the UI can point at the cause. */
  step: number;
  /** Status Level, where the debuff has one: Breach's strength rides on it. */
  level?: number;
}

/** A counter over time: Vulnerable, or one element's Arts Infliction. */
export interface StackSeries {
  label: string;
  kind: 'vulnerable' | 'infliction';
  element?: string;
  /** Step graph: value holds until the next point. */
  points: Array<{ t: number; value: number; consumed?: number; step: number }>;
  peak: number;
}

/**
 * An action the engine says could follow but the rotation does not press:
 * a combo whose trigger is open, or the Final Strike that would finish a
 * BA's chain.
 *
 * `after` is the position in the step list (0-based, count of steps before
 * it): clicking the ghost inserts the action there.
 */
export interface ComboGhost {
  kind: 'CS' | 'FS';
  key: string;
  at: number;
  /** Seconds the ghost would take, for its width; `null` — a fixed small block. */
  seconds: number | null;
  after: number;
  /** The step after which the trigger is open; formatted where it is shown. */
  openedBy: { actor: string; action: string; step: number };
}

/** A stretch of the track during which one operator is controlled. */
export interface ControlSpan {
  key: string;
  from: number;
  to: number;
}

export interface TrackView {
  variant: string | null;
  /** What the track was played against: an enemy, or the dummy with or without a meter. */
  target: Target;
  /** Who is controlled before the first step: chosen, or picked by the engine. */
  controlledAtStart: string | null;
  /** Who is controlled when: control moves with attacks and with Laevatain's ultimate. */
  control: ControlSpan[];
  /** Combos that open and go unused — drawn as dashed blocks. */
  ghosts: ComboGhost[];
  frames: Frame[];
  lanes: TrackLane[];
  spans: RibbonSpan[];
  /** Stack counters. These are spent, not timed, so they are not spans. */
  stacks: StackSeries[];
  /** SP over the whole track, cap 300 = three bars of 100. */
  spTimeline: Array<{ t: number; sp: number }>;
  /** Passive regen, SP per second: SP between timeline points is derived with it. */
  spRegen: number;
  /** Total seconds, including waits the engine derived from cooldowns. */
  length: number;
  waited: number;
  problems: Array<{ step: number; message: Message }>;
  /** Verdicts that flip when action durations are scaled: these need measuring. */
  fragile: string[];
}

/**
 * What the track needs besides the steps: who stands where, and with what.
 *
 * `order` is the team position — slot 01 first. `builds` are the user's own
 * edits from the build editor; without them the roster snapshot is used, so
 * the track and the build tooltip never disagree about a skill level.
 */
export interface TrackSetup {
  order: string[];
  priority: string[];
  ultimatesCharged?: boolean;
  /** The rotation's `controlled:` line. */
  controlled?: string | null;
  /** With no enemy picked: the dummy takes this class's typical stagger meter (`dummyTarget`). */
  dummyClass?: string | null;
  builds?: Record<
    string,
    { level: number; elite: number; potential?: number; skills: TeamMember['skills'] } | undefined
  > | undefined;
  /** Whole builds, gear and weapon included: the Stagger a member deals depends on them (`staggerModifiersFor`). */
  buildOf?: ((key: string) => Build | null) | undefined;
}

/** Potential for the effects layer: the edited build first, then the roster. */
function potentialFor(bundle: Bundle, setup: TrackSetup): (key: string) => number {
  return (key) => setup.builds?.[key]?.potential ?? bundle.roster?.operators?.[key]?.potential ?? 0;
}

export function teamFor(bundle: Bundle, steps: RotStep[], setup: TrackSetup): Map<string, TeamMember> {
  const team = teamFromRoster(bundle, setup.order, steps);
  for (const member of team.values()) {
    const build = setup.builds?.[member.key];
    if (!build) continue;
    member.level = build.level;
    member.elite = build.elite;
    member.skills = build.skills;
  }
  return team;
}

/**
 * Reads debuff windows back out of the frames.
 *
 * Only terms that behave as **timed debuffs** appear here. Vulnerable and
 * Arts Inflictions are deliberately excluded: they are stacks that get
 * consumed, and the first version drawing them as windows hanging over the
 * whole rotation was simply wrong — Crush eats them the moment it lands.
 * Breach is the opposite case: it eats stacks, but leaves a timed debuff
 * behind, so it is a window like any other.
 *
 * A window whose duration the wiki does not give stays `to: null`, and the
 * track draws a marker rather than a bar. Guessing where it closes would be
 * exactly the kind of plausible invention this project avoids. A window
 * that leaves the target before its time — consumed, like Originium
 * Crystals — closes at the step that took it.
 */
function ribbonFrom(frames: Frame[]): RibbonSpan[] {
  const spans: RibbonSpan[] = [];
  const open = new Map<string, RibbonSpan>();

  for (const frame of frames) {
    // Link stands on the team, not on the target, but it is a window all the same.
    const onTarget = (term: string) =>
      frame.target.debuffs.find((item) => item.term === term) ?? frame.links.find((item) => item.term === term);
    for (const [term, span] of open) {
      if (onTarget(term)) continue;
      if (span.to == null || span.to > frame.world) span.to = frame.world;
      open.delete(term);
    }

    for (const event of frame.status) {
      const debuff = onTarget(event.term);
      if (event.kind !== 'other' && !debuff) continue;
      const previous = open.get(event.term);
      // A refresh restarts the window rather than extending the old one.
      if (previous && previous.to != null && previous.to <= frame.world) open.delete(event.term);
      const current = open.get(event.term);
      if (current) {
        // Re-applied while still up: the same window, now ending later.
        if (debuff && debuff.appliedAt === frame.world) {
          current.to = debuff.expiresAt;
          if (debuff.level != null) current.level = debuff.level;
        }
        continue;
      }
      const span: RibbonSpan = {
        term: event.term,
        from: frame.world,
        to: debuff?.expiresAt ?? null,
        step: frame.step.index,
        ...(debuff?.level != null ? { level: debuff.level } : {}),
      };
      open.set(event.term, span);
      spans.push(span);
    }
  }

  return spans;
}

/**
 * Stack counters over time, as step graphs.
 *
 * Separate from the ribbon on purpose. A player reading the track asks "how
 * many Vulnerable stacks are up right now", because that is Status Level and
 * it is what Crush multiplies by. A bar saying "Lift is active" answers a
 * question nobody has.
 */
function stacksFrom(frames: Frame[]): StackSeries[] {
  const vulnerable: StackSeries = {
    label: 'Vulnerable',
    kind: 'vulnerable',
    points: [{ t: 0, value: 0, step: 0 }],
    peak: 0,
  };
  const byElement = new Map<string, StackSeries>();

  for (const frame of frames) {
    const consumedVuln = frame.status.find((event) => event.kind === 'consumesVulnerable');
    const last = vulnerable.points[vulnerable.points.length - 1];
    if (!last || last.value !== frame.target.vulnerable) {
      vulnerable.points.push(
        consumedVuln?.consumed
          ? { t: frame.world, value: frame.target.vulnerable, consumed: consumedVuln.consumed, step: frame.step.index }
          : { t: frame.world, value: frame.target.vulnerable, step: frame.step.index },
      );
      vulnerable.peak = Math.max(vulnerable.peak, frame.target.vulnerable);
    }

    for (const [element, value] of Object.entries(frame.target.inflictions)) {
      if (value === 0 && !byElement.has(element)) continue;
      let series = byElement.get(element);
      if (!series) {
        series = {
          label: `${element} Infliction`,
          kind: 'infliction',
          element,
          points: [{ t: 0, value: 0, step: 0 }],
          peak: 0,
        };
        byElement.set(element, series);
      }
      const previous = series.points[series.points.length - 1];
      if (!previous || previous.value !== value) {
        const eaten = frame.status.find(
          (event) => event.kind === 'consumesInfliction' && event.element === element,
        );
        series.points.push(
          eaten?.consumed
            ? { t: frame.world, value, consumed: eaten.consumed, step: frame.step.index }
            : { t: frame.world, value, step: frame.step.index },
        );
        series.peak = Math.max(series.peak, value);
      }
    }
  }

  const out: StackSeries[] = [];
  if (vulnerable.peak > 0) out.push(vulnerable);
  for (const series of byElement.values()) if (series.peak > 0) out.push(series);
  return out;
}

/**
 * Combos that open and are not cast.
 *
 * A combo opens when its operator appears in a frame's `combos` without
 * having been there a frame earlier — or again after that operator cast it.
 * If the rotation casts it before it closes, it is not a ghost.
 */
function ghostsFrom(frames: Frame[]): ComboGhost[] {
  const ghosts: ComboGhost[] = [];
  const pending = new Map<string, ComboGhost>();
  let open = new Set<string>();

  frames.forEach((frame, position) => {
    const casting = frame.step.kind === 'CS' && !(frame.step.sequence != null && frame.step.sequence > 1);
    if (casting && frame.step.actor) {
      pending.delete(frame.step.actor);
      open.delete(frame.step.actor);
    }
    const now = new Set<string>();
    for (const combo of frame.combos) {
      now.add(combo.key);
      if (open.has(combo.key) || pending.has(combo.key)) continue;
      pending.set(combo.key, {
        kind: 'CS',
        key: combo.key,
        at: combo.at,
        seconds: null,
        after: position + 1,
        openedBy: {
          actor: frame.step.actor ?? frame.step.actorRaw,
          action: `${frame.step.kind}${frame.step.sequence ?? ''}`,
          step: position + 1,
        },
      });
    }
    for (const key of [...pending.keys()]) {
      if (!now.has(key)) {
        ghosts.push(pending.get(key)!);
        pending.delete(key);
      }
    }
    open = now;
  });
  ghosts.push(...pending.values());
  return ghosts;
}

/**
 * A BA whose chain the rotation leaves unfinished: the Final Strike it
 * stops short of, right after it. The engine plays a BA as the hits up to
 * the Final Strike, so `BA` alone gives no Final Strike SP and opens no
 * Final Strike combo — the ghost says where one would go.
 */
function strikeGhostsFrom(bundle: Bundle, frames: Frame[]): ComboGhost[] {
  const ghosts: ComboGhost[] = [];
  frames.forEach((frame, position) => {
    const { step } = frame;
    if (step.kind !== 'BA' || step.sequence != null || !step.actor) return;
    // The engine marks the FS that finishes this chain; any other controlled
    // action next leaves it unfinished.
    if (frames.slice(position + 1).find((next) => CONTROLLED_KINDS.has(next.step.kind))?.chained) return;
    const basic = bundle.sp?.basicAttack?.[step.actor];
    ghosts.push({
      kind: 'FS',
      key: step.actor,
      at: frame.world + frame.duration,
      seconds: basic?.finalStrikeSeconds ?? null,
      after: position + 1,
      openedBy: { actor: step.actor, action: 'BA', step: position + 1 },
    });
  });
  return ghosts;
}

/**
 * One variant, simulated and turned into a drawable view.
 *
 * Split out of `buildTrack` so the editor can run the very same path on a
 * draft it is holding in memory. Two ways of turning steps into a track
 * would drift, and the editor would start showing windows the browsing
 * screen does not.
 */
export function viewFromSteps(
  bundle: Bundle,
  steps: RotStep[],
  enemyKey: string | null,
  variant: string | null,
  setup: TrackSetup,
): TrackView {
  const team = teamFor(bundle, steps, setup);
  return viewFor(bundle, { variant, steps }, {
    team,
    target: targetFor(bundle, enemyKey, setup.dummyClass ?? null),
    priority: setup.priority,
    reactionBonus: reactionBonusFor(bundle, team, potentialFor(bundle, setup)),
    modifiers: simModifiersFor(bundle, team, potentialFor(bundle, setup), setup.buildOf),
    ultimatesCharged: setup.ultimatesCharged ?? false,
    controlled: setup.controlled ?? null,
  });
}

interface SimContext {
  team: Map<string, TeamMember>;
  priority: string[];
  target: Target;
  reactionBonus: Record<string, Record<string, number>>;
  modifiers: Record<string, SimModifiers>;
  ultimatesCharged: boolean;
  controlled: string | null;
}

function viewFor(bundle: Bundle, part: { variant: string | null; steps: RotStep[] }, context: SimContext): TrackView {
  const { team, target, priority, reactionBonus, modifiers, ultimatesCharged, controlled } = context;
  // Fragility: the same track at shorter and longer action durations. A
  // verdict that survives every pass is true whatever the real timings turn
  // out to be; one that flips is waiting on a measurement.
  const { result, fragile } = simulateVariant(bundle, part.steps, team, {
    target,
    priority,
    reactionBonus,
    modifiers,
    ultimatesCharged,
    controlled,
  });

  const lanes: TrackLane[] = [...team.values()]
    .map((member, index) => {
      const ultCost = ultimateCost(member, modifiers[member.key]);
      return {
        key: member.key,
        slot: member.slot ?? index + 1,
        name: member.operator.name,
        icon: member.operator.icon,
        element: member.operator.element,
        frames: result.frames.filter((frame) => frame.step.actor === member.key),
        ultCost,
        startEnergy: ultimatesCharged ? ultCost : 0,
      };
    })
    .sort((a, b) => a.slot - b.slot);

  return {
    variant: part.variant,
    target,
    controlledAtStart: result.controlled,
    control: controlFrom(result.controlled, result.frames, result.real),
    ghosts: [...ghostsFrom(result.frames), ...strikeGhostsFrom(bundle, result.frames)],
    frames: result.frames,
    lanes,
    spans: ribbonFrom(result.frames),
    stacks: stacksFrom(result.frames),
    spTimeline: result.spTimeline,
    spRegen: result.regen,
    length: result.real,
    waited: result.waited,
    problems: result.frames.flatMap((frame) =>
      frame.problems.map((message) => ({ step: frame.step.index, message })),
    ),
    fragile,
  };
}

export function buildTrack(
  bundle: Bundle,
  rotationText: string,
  enemyKey: string | null,
  builds?: TrackSetup['builds'],
  dummyClass: string | null = null,
  buildOf?: TrackSetup['buildOf'],
): { rotation: Rotation; views: TrackView[] } {
  const rotation = parseRot(rotationText, buildAliases(bundle));
  const setup: TrackSetup = {
    order: rotation.team,
    priority: rotation.priority,
    ultimatesCharged: rotation.ultimatesCharged ?? false,
    controlled: rotation.controlled ?? null,
    ...(builds ? { builds } : {}),
    ...(buildOf ? { buildOf } : {}),
  };
  const target = targetFor(bundle, enemyKey, dummyClass);
  const views = splitVariants(rotation.steps).map((part) => {
    const team = teamFor(bundle, part.steps, setup);
    return viewFor(bundle, part, {
      team,
      target,
      priority: rotation.priority,
      reactionBonus: reactionBonusFor(bundle, team, potentialFor(bundle, setup)),
      modifiers: simModifiersFor(bundle, team, potentialFor(bundle, setup), setup.buildOf),
      ultimatesCharged: setup.ultimatesCharged ?? false,
      controlled: setup.controlled ?? null,
    });
  });
  return { rotation, views };
}

/** Control over time: a new span wherever a step moved it. */
function controlFrom(start: string | null, frames: Frame[], length: number): ControlSpan[] {
  const spans: ControlSpan[] = [];
  let current: ControlSpan | null = start ? { key: start, from: 0, to: length } : null;
  for (const frame of frames) {
    if (frame.controlled === (current?.key ?? null)) continue;
    if (current) spans.push({ ...current, to: frame.world });
    current = frame.controlled ? { key: frame.controlled, from: frame.world, to: length } : null;
  }
  if (current) spans.push(current);
  return spans.filter((span) => span.to > span.from + 1e-9);
}

/** The frame the playhead is sitting on: the last one at or before `t`. */
export function frameAt(frames: Frame[], t: number): Frame | null {
  let found: Frame | null = null;
  for (const frame of frames) {
    if (frame.world <= t + 1e-9) found = frame;
    else break;
  }
  return found;
}
