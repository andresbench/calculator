/**
 * Time on the rotation track.
 *
 * Most durations now come from the client's frames (`basic_attacks.json`:
 * chains, skill windows, hits). What is left here — `timings.yaml` — is the
 * nominal fallback for what the frames do not give: a finisher, a dive, a
 * dodge, an operator without frames. The module is built so that a nominal
 * value never turns into false precision.
 *
 * TWO CLOCKS
 * ----------
 * The engine keeps two clocks, `world` (buffs, debuffs and cooldowns expire
 * by it) and `real` (damage per second is counted by it), for the case that
 * buff timers froze during an animation. Measured: nothing freezes,
 * ultimates included (measurements, #16), so `freezes_timers` in the YAML is
 * empty and today the two clocks always advance together. An action marked
 * `freezesTimers` would NOT freeze timers in the current code: the flag only
 * keeps hits in flight from landing at the end of that step (`simulate.ts`,
 * the end-of-step landing). A real freeze needs its own implementation; the
 * flag is kept so the data can name the action when one turns up.
 *
 * VERDICT FRAGILITY
 * -----------------
 * Instead of pretending the second is right, the engine runs the track
 * several times with the nominal durations multiplied. Client frames are
 * not scaled: scaling one number and not the next moved events across
 * presses and made noise. A verdict that does not change between runs holds
 * whatever the unknown timings are; one that flips is marked fragile and
 * needs a measurement.
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
  /**
   * Seconds a combo stays ready after its trigger (measurements, #65): the
   * button goes dark after that. Missing — the engine does not check it.
   */
  comboReady?: number;
  /**
   * How fast the world runs under a combo's slowdown, for everyone but the
   * caster (measurements, #64): 0.05. Missing — it stands still.
   */
  comboTimeScale?: number;
}

export const FALLBACK_TIMINGS: Timings = {
  meta: { measured: false, note: 'built-in values: timings.yaml did not load' },
  defaults: { BA: 1, FS: 1, FIN: 1, DIVE: 1, BS: 1, CS: 1, ULT: 1, DODGE: 1, WAIT: 0 },
  freezesTimers: {},
  sensitivity: [0.5, 1, 2],
  overrides: {},
};

/**
 * How long an action lasts, when the client's frames do not say.
 * `scale` is the multiplier for the fragility check: only these nominal
 * values are scaled (ENGINE_CORE_PLAN.md, §3.6).
 */
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
