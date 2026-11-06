/**
 * Time on the rotation track.
 *
 * Action durations are not given on the wiki or in the game in readable
 * form, so the values in `timings.yaml` are nominal. The module is built so
 * that a nominal value never turns into false precision.
 *
 * TWO CLOCKS
 * ----------
 * If buff timers froze during an animation, "how much time has passed"
 * would be two different numbers:
 *
 *   world  — buffs, debuffs and cooldowns expire by it;
 *   real   — damage per second is counted by it.
 *
 * An action with `freezesTimers` advances only `real`. Measured: nothing
 * freezes, ultimates included (measurements, #16), so `freezes_timers` in
 * the YAML is empty. The mechanism stays in case an action that does
 * freeze turns up.
 *
 * VERDICT FRAGILITY
 * -----------------
 * Instead of pretending the second is right, the engine runs the track
 * several times with different duration multipliers. A verdict that does
 * not change between runs holds whatever the timings; one that flips is
 * marked fragile and needs a measurement.
 */

export type ActionKind = 'BA' | 'FS' | 'FIN' | 'DIVE' | 'BS' | 'CS' | 'ULT' | 'DODGE' | 'WAIT';

/**
 * Actions that are not a skill: a dodge and a pause. They take time on the
 * track — SP regenerates, debuffs run out — and do nothing else, apart from
 * the SP of a perfect dodge.
 */
export const FILLER_KINDS: ReadonlySet<ActionKind> = new Set(['DODGE', 'WAIT']);

export interface Timings {
  meta: { measured: boolean; updated?: string; note?: string };
  defaults: Partial<Record<ActionKind, number>>;
  freezesTimers: Partial<Record<ActionKind, boolean>>;
  sensitivity: number[];
  overrides: Record<string, number>;
}

export const FALLBACK_TIMINGS: Timings = {
  meta: { measured: false, note: 'built-in values: timings.yaml did not load' },
  defaults: { BA: 1, FS: 1, FIN: 1, DIVE: 1, BS: 1, CS: 1, ULT: 1, DODGE: 1, WAIT: 0 },
  freezesTimers: {},
  sensitivity: [0.5, 1, 2],
  overrides: {},
};

/** How long an action lasts. `scale` is the multiplier for the fragility check. */
export function durationOf(
  timings: Timings,
  kind: ActionKind,
  operator: string,
  skillType: string,
  scale = 1,
): number {
  const override = timings.overrides[`${operator}: ${skillType}`];
  const base = override ?? timings.defaults[kind] ?? 1;
  return base * scale;
}

/** Whether timers freeze for the duration of this action. */
export function freezesTimers(timings: Timings, kind: ActionKind): boolean {
  return timings.freezesTimers[kind] ?? false;
}
