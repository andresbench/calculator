/**
 * One way from a bundle and a rotation to a simulated track.
 *
 * The CLI (`sim.ts`) and the app's track (`app/src/track.ts`) used to wire
 * `simulate` up each on their own, and the copies drifted: the CLI lost
 * Arcane's reaction bonus, resolved aliases with its own reader of
 * `aliases.yaml`, and translated the SP table separately. Everything that
 * turns bundle data into simulation options lives here now, and both callers
 * only decide who is in the team.
 */

import { analyse, type Build } from './build.js';
import type { Bundle } from './bundle.js';
import { canonicalTerm } from './buffs.js';
import { activeEffects, effectModifiers } from './effects.js';
import { formatMessage, type Message } from './messages.js';
import type { RotStep } from './rot.js';
import {
  DUMMY,
  FALLBACK_SP,
  simulate,
  type SimModifiers,
  type SimulationResult,
  type StaggerModifiers,
  type Target,
  type TeamMember,
} from './simulate.js';
import { FALLBACK_TIMINGS } from './timing.js';
import { EMPTY_SYNERGY } from './triggers.js';

/** Enemy classes as the game ranks them. */
export const ENEMY_CLASSES = ['Common', 'Advanced', 'Elite', 'Alpha', 'Boss'] as const;

/**
 * The value most of `values` share; a tie goes to the one that sorts first
 * as text, so the answer does not depend on the bundle's key order.
 */
function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<string, { value: T; count: number }>();
  for (const value of values) {
    const key = JSON.stringify(value);
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  return [...counts.entries()].sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0))[0]?.[1].value;
}

/**
 * The dummy with the stagger meter of a typical enemy of one class.
 *
 * The plain dummy has no meter, so nothing on the track can stagger it and a
 * finisher cannot be played. This one keeps the dummy's DEF and resistances
 * and takes each stagger number — meter, recovery, Stagger Nodes, Finisher
 * ATK Mult and SP — as the most common one among that class's enemies in the
 * bundle. Nothing is made up: a class with no meter in the data gives the
 * plain dummy.
 */
export function dummyTarget(bundle: Bundle, enemyClass: string | null | undefined): Target {
  if (!enemyClass) return DUMMY;
  const enemies = Object.values(bundle.enemies).filter((enemy) => enemy.class === enemyClass && enemy.stagger.hp != null);
  const meter = mostCommon(enemies.map((enemy) => enemy.stagger.hp!));
  if (meter == null) return DUMMY;
  return {
    name: `dummy (${enemyClass})`,
    staggerMeter: meter,
    staggerRecovery: mostCommon(enemies.map((enemy) => enemy.stagger.recovery)) ?? 0,
    staggerNodes: mostCommon(enemies.map((enemy) => enemy.stagger.nodes ?? [])) ?? [],
    finisherMultiplier: mostCommon(enemies.map((enemy) => enemy.finisherMultiplier ?? 1)) ?? 1,
    finisherSp: mostCommon(enemies.map((enemy) => enemy.finisherSp ?? 0)) ?? 0,
  };
}

/**
 * The enemy a track is played against; unknown or null is the dummy, with
 * the stagger meter of `dummyClass` when one is given.
 */
export function targetFor(
  bundle: Bundle,
  enemyKey: string | null | undefined,
  dummyClass: string | null = null,
): Target {
  const enemy = enemyKey ? bundle.enemies[enemyKey] : undefined;
  if (!enemy) return dummyTarget(bundle, dummyClass);
  return {
    name: enemy.key,
    staggerMeter: enemy.stagger.hp,
    staggerRecovery: enemy.stagger.recovery,
    staggerNodes: enemy.stagger.nodes ?? [],
    finisherMultiplier: enemy.finisherMultiplier ?? 1,
    finisherSp: enemy.finisherSp ?? 0,
  };
}

/**
 * Seconds each member adds to the reactions they apply — Arcane's Weapon
 * Honing on Corrosion. Read from the effects layer at the member's elite and
 * potential, the same entries the build editor switches on.
 *
 * `potentialOf` is the caller's: the app takes it from the edited build, the
 * CLI from the roster.
 */
export function reactionBonusFor(
  bundle: Bundle,
  team: Map<string, TeamMember>,
  potentialOf: (key: string) => number,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const member of team.values()) {
    const active = activeEffects(bundle.effects, {
      operator: member.key,
      elite: member.elite ?? 4,
      potential: potentialOf(member.key),
    });
    const seconds = effectModifiers(active).reactionSeconds;
    if (Object.keys(seconds).length > 0) out[member.key] = seconds;
  }
  return out;
}

/**
 * What each member's talents and potentials change in the resources: combo
 * cooldown (Chen's P5), ultimate cost (the common P4 −15 %), SP returned on
 * consuming a term (the Endministrator's P1). Operator effects only, unless
 * `buildOf` gives the builds: then also what gear and weapon add to the
 * Stagger the member deals (`staggerModifiersFor`).
 */
export function simModifiersFor(
  bundle: Bundle,
  team: Map<string, TeamMember>,
  potentialOf: (key: string) => number,
  buildOf?: (key: string) => Build | null,
): Record<string, SimModifiers> {
  const out: Record<string, SimModifiers> = {};
  for (const member of team.values()) {
    const active = activeEffects(bundle.effects, {
      operator: member.key,
      elite: member.elite ?? 4,
      potential: potentialOf(member.key),
    });
    const mods = effectModifiers(active);
    const spOnConsume: NonNullable<SimModifiers['spOnConsume']> = [];
    for (const effect of active) {
      for (const apply of effect.apply) {
        const term = apply.trigger?.startsWith('consumes:') ? apply.trigger.slice('consumes:'.length) : null;
        if (apply.stat !== 'sp_return' || !term) continue;
        spOnConsume.push({
          term: canonicalTerm(term),
          sp: apply.value,
          ...(apply.skillType ? { skillType: apply.skillType } : {}),
        });
      }
    }
    out[member.key] = {
      cooldownFlat: mods.cooldownFlat,
      cooldownPct: mods.cooldownPct,
      ultCostPct: mods.ultCostPct,
      spOnConsume,
      reactionEdits: mods.reactionEdits,
      grants: active.flatMap((effect) => effect.grants ?? []),
    };
    const build = buildOf?.(member.key);
    const stagger = build ? staggerModifiersFor(bundle, build) : null;
    if (stagger) out[member.key]!.stagger = stagger;
  }
  return out;
}

/**
 * What a build adds to the Stagger its operator deals (measurements, #62):
 * Stagger Efficiency from the stat sheet (Swordmancer's +20 %), Arts
 * Intensity for Lift and Knock Down, and effect hits with their own Stagger
 * (`extra_hit` with `stagger`).
 */
export function staggerModifiersFor(bundle: Bundle, build: Build): StaggerModifiers | null {
  const analysis = analyse(build, bundle, { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} });
  if (!analysis) return null;
  const hits: StaggerModifiers['hits'] = [];
  for (const effect of analysis.effects.active) {
    for (const apply of effect.apply) {
      if (apply.stat !== 'extra_hit' || !apply.stagger || !apply.trigger?.startsWith('applies:')) continue;
      hits.push({
        name: apply.name ?? effect.id,
        on: apply.trigger.slice('applies:'.length),
        cooldown: apply.cooldown ?? 0,
        stagger: apply.stagger,
      });
    }
  }
  return { efficiency: analysis.sheet.staggerEfficiency, artsIntensity: analysis.sheet.artsIntensity, hits };
}

/** Potential as the roster snapshot has it; 0 when unknown. */
export function rosterPotential(bundle: Bundle): (key: string) => number {
  return (key) => bundle.roster?.operators?.[key]?.potential ?? 0;
}

export interface VariantOptions {
  target?: Target;
  /** Combo Skill Priority Settings: the rotation's `priority:` line. */
  priority?: string[];
  reactionBonus?: Record<string, Record<string, number>>;
  /** Resource changes from talents and potentials: `simModifiersFor`. */
  modifiers?: Record<string, SimModifiers>;
  ultimatesCharged?: boolean;
  /** The rotation's `sp: unlimited` line. */
  unlimitedSp?: boolean;
  /** The rotation's `controlled:` line. */
  controlled?: string | null;
}

export interface VariantRun {
  result: SimulationResult;
  /**
   * Verdict keys that change between the sensitivity passes (action durations
   * scaled by `timings.sensitivity`). A verdict that survives every pass holds
   * whatever the real durations are; one that flips waits on a measurement.
   */
  fragile: string[];
  /** Every verdict of every pass, for callers that show how a verdict flips. */
  passes: Array<{ scale: number; verdicts: Map<string, Message> }>;
}

/**
 * Simulates one variant of a rotation, plus the sensitivity passes.
 *
 * Expects the steps of **one variant** (`splitVariants`) and a team in
 * team-position order: slot 01 first.
 */
export function simulateVariant(
  bundle: Bundle,
  steps: RotStep[],
  team: Map<string, TeamMember>,
  options: VariantOptions = {},
): VariantRun {
  const timings = bundle.timings ?? FALLBACK_TIMINGS;
  const shared = {
    target: options.target ?? DUMMY,
    sp: bundle.sp ?? FALLBACK_SP,
    synergy: bundle.synergy ?? EMPTY_SYNERGY,
    comboPriority: options.priority ?? [],
    reactionBonus: options.reactionBonus ?? {},
    modifiers: options.modifiers ?? {},
    ultimatesCharged: options.ultimatesCharged ?? false,
    unlimitedSp: options.unlimitedSp ?? false,
    controlled: options.controlled ?? null,
  };
  const result = simulate(steps, team, timings, { ...shared, scale: 1 });

  const scales = timings.sensitivity.length > 0 ? timings.sensitivity : [1];
  const passes = scales.map((scale) => {
    const verdicts = new Map<string, Message>();
    for (const frame of simulate(steps, team, timings, { ...shared, scale }).frames) {
      for (const [key, value] of frame.verdicts) verdicts.set(key, value);
    }
    return { scale, verdicts };
  });
  const keys = new Set<string>();
  for (const pass of passes) for (const key of pass.verdicts.keys()) keys.add(key);
  // Compared as English text on purpose: the text rounds times to a tenth of
  // a second, so passes that differ by a rounding error agree.
  const said = (verdict: Message | undefined): string => (verdict ? formatMessage(verdict) : '—');
  const fragile = [...keys].filter((key) => new Set(passes.map((pass) => said(pass.verdicts.get(key)))).size > 1);

  return { result, fragile, passes };
}
