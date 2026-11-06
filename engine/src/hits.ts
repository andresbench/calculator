/**
 * Which damage rows a rotation step deals.
 *
 * What a row means — a hit, a per-stack bonus or a conditional hit — is
 * decided in `export.py` (`hit_roles`) and stored in `StatRow.hit`. This
 * module only picks rows by action:
 *
 * * `BA` with no number — the chain up to the Final Strike, `FS` right
 *   after it — the last hit, so `BA > FS` is one full chain. An `FS` on its
 *   own walks the whole chain. The damage covers the same time as the
 *   duration the engine gives (measurements, #35), or damage per second
 *   lies. `BA3` is the third hit alone.
 * * `FIN` — finisher, `DIVE` — plunging attack.
 * * A skill with a sequence number (`CS2`, `BS3`) — the rows of that
 *   sequence; the first sequence also gets the unnumbered rows. An
 *   unnumbered per-stack bonus goes to any sequence: Rossi's second one eats
 *   the stacks, and on the first there are none. No number — every hit of
 *   the skill.
 *
 * A move's chain plays like the basic attack's: Laevatain's `BA > FS` inside
 * her ultimate is the `Enhanced BATK` chain of the ultimate's rows
 * (`Skill.enhancedBasic`), and `context.move` names it.
 *
 * A conditional row counts only when the step met the condition its `when`
 * names: Lifeng's additional hit when the ultimate spent Link, the
 * Endministrator's bonus hit when her ultimate shattered the crystals,
 * Pogranichnik's enhanced third slash on four stacks. Without a `when` the
 * track cannot know the condition, and the row is left out. A `delayed` row
 * is never the cast's own hit: the track places it where it lands.
 */

import type { Skill, StatRow } from './bundle.js';
import type { RotStep } from './rot.js';

export interface StepHit {
  row: StatRow;
  /** `perStack` — multiply the row by the stacks consumed (`Frame.stacksForHit`). */
  role: 'hit' | 'perStack';
  /**
   * How many times the row hits per step: Chen's ultimate "Slash
   * Multiplier" is 6. `null` — the hit count is unknown (it depends on time
   * or stacks); the track counts one and lists it as not modelled.
   */
  count: number | null;
}

/**
 * What the step did that conditional rows ask about. `consumed` — terms the
 * cast itself took (Link it spent, crystals it shattered); `moves` and
 * `enhanced` — for a skill whose stacks decide its sequences (`Frame.moves`).
 * `chained` — an `FS` that finishes the BA before it (`Frame.chained`).
 */
export interface HitContext {
  consumed?: ReadonlySet<string>;
  /** A transformed move (`Frame.transformed`): only its rows, not the host's own cast. */
  move?: string | null;
  /** How many the cast made (`Frame.stock`): a `per` row hits that many times. */
  made?: number | null;
  moves?: number | null;
  enhanced?: boolean;
  chained?: boolean;
  /** What the target had when the cast landed: `target_has:<term>` rows (Estella's combo on Solidification). */
  targetHas?: (term: string) => boolean;
}

/** Whether a conditional row's `when` held at this step. */
export function holds(when: string | undefined, context: HitContext): boolean {
  if (!when) return false;
  const [kind, arg] = [when.slice(0, when.indexOf(':')), when.slice(when.indexOf(':') + 1)];
  if (kind === 'consumes') return context.consumed?.has(arg) ?? false;
  if (kind === 'stacks') return context.enhanced ?? false;
  if (kind === 'target_has') return context.targetHas?.(arg) ?? false;
  if (kind === 'target_lacks') return !(context.targetHas?.(arg) ?? false);
  return false;
}

export function stepHits(
  skill: Skill,
  step: Pick<RotStep, 'kind' | 'sequence'>,
  context: HitContext = {},
): StepHit[] {
  // An enhanced row that held replaces the plain row of its sequence.
  const replaced = new Set(
    skill.stats
      .filter((row) => row.hit?.role === 'conditional' && row.hit.when?.startsWith('stacks:') && holds(row.hit.when, context))
      .map((row) => row.hit!.sequence),
  );
  const rows = skill.stats.filter((row) => {
    const hit = row.hit;
    if (!hit || hit.role === 'delayed') return false;
    if ((row.move ?? null) !== (context.move ?? null)) return false;
    if (hit.role === 'conditional') return holds(hit.when, context);
    if (hit.sequence != null && replaced.has(hit.sequence)) return false;
    // The stacks decided how many sequences the cast made.
    if (context.moves != null && hit.sequence != null && hit.sequence > context.moves) return false;
    return true;
  });
  const pick = (row: StatRow): StepHit => ({
    row,
    role: row.hit!.role === 'perStack' ? 'perStack' : 'hit',
    count: row.hit!.per ? (context.made ?? 1) : row.hit!.count === undefined ? 1 : row.hit!.count,
  });

  const enhancedChain = context.move != null && (step.kind === 'BA' || step.kind === 'FS');
  if (skill.type === 'Basic Attack' || enhancedChain) {
    const part = step.kind === 'FIN' ? 'finisher' : step.kind === 'DIVE' ? 'dive' : 'chain';
    const own = rows.filter((row) => row.hit!.part === part);
    if (part !== 'chain') return own.map(pick);
    if (step.sequence != null) return own.filter((row) => row.hit!.sequence === step.sequence).map(pick);
    // The Final Strike is the chain's last sequence.
    const last = Math.max(...own.map((row) => row.hit!.sequence ?? 0));
    if (step.kind === 'BA') return own.filter((row) => row.hit!.sequence !== last).map(pick);
    if (context.chained) return own.filter((row) => row.hit!.sequence === last).map(pick);
    return own.map(pick);
  }

  if (step.sequence == null) return rows.map(pick);
  return rows
    .filter(
      (row) =>
        row.hit!.sequence === step.sequence ||
        (row.hit!.sequence == null && (step.sequence === 1 || row.hit!.role === 'perStack')),
    )
    .map(pick);
}
