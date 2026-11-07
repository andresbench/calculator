/**
 * A rotation draft: what the app edits.
 *
 * **A draft stores order, not time.** This is the editor's central
 * decision. Where an action lands on the time axis is up to the engine:
 * combo cooldown, waiting for SP and animation length are its data. Letting
 * the user drag a block to second 3.5 would invite them to lie to the
 * simulation and then show a result that does not match the picture. So the
 * sequence is what gets edited, and the track stays its reflection.
 *
 * A draft is always a copy. The files in `rotations/` are played as written
 * and serve as the engine's acceptance test, so the app never rewrites them:
 * "duplicate" makes a copy in the browser, and a rotation goes back out as
 * text that the user puts into the repository themselves — or that someone
 * else imports into their own browser (`draftsFromText`).
 */

import { stagesArePresses } from './actions.js';
import type { Message } from './messages.js';
import type { Bundle } from './bundle.js';
import { buildAliases, formatRot, parseRot, type Rotation, type RotStep } from './rot.js';
import type { ActionKind } from './timing.js';

export interface DraftStep {
  /** Stable id: selection and drag-and-drop key on it. */
  id: string;
  /** Operator key. Unlike a file, a draft always knows it exactly. */
  actor: string;
  kind: ActionKind;
  sequence: number | null;
  /** Length of a `WAIT`, seconds. Older drafts lack the field. */
  seconds?: number | null;
  optional: boolean;
  uncertain: boolean;
  note: string | null;
  cycle: number;
}

export interface Draft {
  id: string;
  title: string;
  /**
   * Up to four operators, in squad order: the first is slot 01. An empty
   * string is an empty slot, so the ones after it keep their numbers.
   */
  team: string[];
  /**
   * Combo priority from the game settings. Empty means squad order. Older
   * drafts in localStorage lack the field, hence optional.
   */
  comboPriority?: string[];
  /** The fight starts with every ultimate charged. */
  ultimatesCharged?: boolean;
  /** SP never runs short (`sp: unlimited`). */
  unlimitedSp?: boolean;
  /** Who is controlled before the first step; missing — the engine picks. */
  controlled?: string;
  variant: string | null;
  steps: DraftStep[];
  enemyKey: string | null;
  /** Where it was copied from, if it is a copy of a repository file. */
  origin: string | null;
  updatedAt: string;
}

export const TEAM_SIZE = 4;

let counter = 0;

/** Step id. Not cryptographic: only for React keys and selection. */
export function nextId(prefix = 's'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

export function emptyDraft(): Draft {
  return {
    id: nextId('r'),
    title: 'New rotation',
    team: [],
    comboPriority: [],
    variant: null,
    steps: [],
    enemyKey: null,
    origin: null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Copies a rotation file into a draft.
 *
 * **One variant** is taken: variants are different ways of playing, each
 * with its own fresh target and cooldowns, and they cannot be glued into one
 * editable sequence. File comments (`#`) are lost on copy — they belong to
 * the file, not to the steps.
 */
export function draftFromRotation(
  rotation: Rotation,
  variant: string | null,
  origin: string,
): Draft {
  const steps = rotation.steps.filter((step) => step.variant === variant);
  // The order of `team:` is squad positions, and the game reads them. An
  // operator with no steps still takes a slot, so the whole team is copied,
  // not only those who act.
  const team: string[] = [...rotation.team];
  for (const step of steps) {
    if (!step.actor || team.includes(step.actor)) continue;
    // Someone who acts but is not in `team:` takes the first empty slot.
    const hole = team.indexOf('');
    if (hole >= 0) team[hole] = step.actor;
    else team.push(step.actor);
  }
  return {
    id: nextId('r'),
    title: rotation.title ?? origin,
    team,
    comboPriority: [...rotation.priority],
    ...(rotation.ultimatesCharged ? { ultimatesCharged: true } : {}),
    ...(rotation.unlimitedSp ? { unlimitedSp: true } : {}),
    ...(rotation.controlled ? { controlled: rotation.controlled } : {}),
    variant,
    steps: steps.map((step) => ({
      id: nextId(),
      actor: step.actor ?? step.actorRaw,
      kind: step.kind,
      sequence: step.sequence,
      ...(step.seconds != null ? { seconds: step.seconds } : {}),
      optional: step.optional,
      uncertain: step.uncertain,
      note: step.note,
      cycle: step.cycle,
    })),
    enemyKey: null,
    origin,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Draft → engine steps.
 *
 * `index` counts from one, as the file parser does: verdicts and problem
 * messages refer to it.
 */
export function draftSteps(draft: Draft): RotStep[] {
  return draft.steps.map((step, index) => ({
    index: index + 1,
    actorRaw: step.actor,
    actor: step.actor,
    kind: step.kind,
    sequence: step.sequence,
    ...(step.seconds != null ? { seconds: step.seconds } : {}),
    optional: step.optional,
    uncertain: step.uncertain,
    note: step.note,
    variant: draft.variant,
    cycle: step.cycle,
    line: index + 1,
  }));
}

/** Draft → `.rot` text that can go into `rotations/`. */
export function draftToText(bundle: Bundle, draft: Draft): string {
  const nameOf = (key: string): string => bundle.operators[key]?.name ?? key;
  const rotation: Rotation = {
    title: draft.title,
    team: draft.team,
    priority: draft.comboPriority ?? [],
    ...(draft.ultimatesCharged ? { ultimatesCharged: true } : {}),
    ...(draft.unlimitedSp ? { unlimitedSp: true } : {}),
    ...(draft.controlled ? { controlled: draft.controlled } : {}),
    steps: draftSteps(draft),
    variants: draft.variant ? [draft.variant] : [],
    warnings: [],
  };
  return formatRot(rotation, nameOf);
}

/**
 * Round-trip check: the draft's text parses back into the same steps.
 *
 * An export that silently drops a step is worse than none: the user commits
 * the file and finds out a week later. So before handing out the text, the
 * editor runs it back through the parser and compares.
 */
export function checkRoundTrip(
  bundle: Bundle,
  draft: Draft,
  text: string,
): { ok: boolean; problems: Message[] } {
  const parsed = parseRot(text, buildAliases(bundle));
  const problems: Message[] = [...parsed.warnings];
  const mine = draftSteps(draft);
  if (parsed.steps.length !== mine.length) {
    problems.push({ code: 'draftStepCount', before: mine.length, after: parsed.steps.length });
  }
  const count = Math.min(parsed.steps.length, mine.length);
  for (let index = 0; index < count; index += 1) {
    const before = mine[index]!;
    const after = parsed.steps[index]!;
    if (
      before.actor !== after.actor ||
      before.kind !== after.kind ||
      before.sequence !== after.sequence ||
      (before.seconds ?? null) !== (after.seconds ?? null)
    ) {
      problems.push({
        code: 'draftStepChanged',
        step: index + 1,
        was: `${before.actor}: ${before.kind}${before.sequence ?? ''}`,
        now: `${after.actor ?? after.actorRaw}: ${after.kind}${after.sequence ?? ''}`,
      });
    }
  }
  return { ok: problems.length === 0, problems };
}

/**
 * Drops stage numbers that are not presses: older palettes offered `BS1` for
 * Lifeng, whose battle skill is one press that swings three times. The
 * engine already plays such a step as the whole skill; this makes the draft
 * say so too. Returns the same object when nothing changes.
 */
export function normaliseStages(bundle: Bundle, draft: Draft): Draft {
  let changed = false;
  const steps = draft.steps.map((step) => {
    if (step.sequence == null || !['BS', 'CS', 'ULT'].includes(step.kind)) return step;
    const type = step.kind === 'BS' ? 'Battle Skill' : step.kind === 'CS' ? 'Combo Skill' : 'Ultimate';
    const skill = bundle.operators[step.actor]?.skills.find((item) => item.type === type);
    if (!skill || stagesArePresses(skill)) return step;
    changed = true;
    return { ...step, sequence: null };
  });
  return changed ? { ...draft, steps, updatedAt: new Date().toISOString() } : draft;
}

/**
 * `.rot` text → drafts: someone else's rotation, pasted or loaded from a
 * file or a link.
 *
 * One draft per variant, as «duplicate» does it: variants are separate ways
 * to play. An operator the bundle does not know stops the import — a draft
 * always knows its operators exactly, and guessing who «Endmin» meant would
 * put the wrong kit on the track. Other parser warnings are returned
 * alongside the drafts: the steps that did parse are still the rotation.
 */
export function draftsFromText(
  bundle: Bundle,
  text: string,
  fallbackTitle: string,
): { drafts: Draft[]; problems: Message[] } {
  const rotation = parseRot(text, buildAliases(bundle));
  const problems: Message[] = [...rotation.warnings];
  const unknown = rotation.team.filter((key) => key && !bundle.operators[key]);
  for (const actor of unknown) problems.push({ code: 'importUnknownOperator', actor });
  const blocked = unknown.length > 0 || rotation.steps.some((step) => !step.actor || !bundle.operators[step.actor]);
  if (blocked) return { drafts: [], problems };
  if (rotation.steps.length === 0 && rotation.team.every((key) => !key)) {
    return { drafts: [], problems: [...problems, { code: 'importEmpty' }] };
  }

  const variants = rotation.variants.length > 0 ? rotation.variants : [null];
  const drafts = variants.map((variant) => ({ ...draftFromRotation(rotation, variant, fallbackTitle), origin: null }));
  const crowded = drafts.find((draft) => draft.team.filter(Boolean).length > TEAM_SIZE);
  if (crowded) {
    return { drafts: [], problems: [...problems, { code: 'importTeamSize', count: crowded.team.filter(Boolean).length }] };
  }
  return { drafts: drafts.map((draft) => normaliseStages(bundle, setTeam(draft, draft.team))), problems };
}

// ------------------------------------------------------------- edits

/** Combo priority. Stored empty when it equals squad order. */
export function setComboPriority(draft: Draft, priority: string[]): Draft {
  const same = priority.length === draft.team.length && priority.every((key, i) => key === draft.team[i]);
  return { ...draft, comboPriority: same ? [] : priority, updatedAt: new Date().toISOString() };
}

export function addStep(draft: Draft, step: Omit<DraftStep, 'id'>, at?: number): Draft {
  const steps = [...draft.steps];
  const entry: DraftStep = { ...step, id: nextId() };
  steps.splice(at ?? steps.length, 0, entry);
  return { ...draft, steps, updatedAt: new Date().toISOString() };
}

export function removeStep(draft: Draft, id: string): Draft {
  return {
    ...draft,
    steps: draft.steps.filter((step) => step.id !== id),
    updatedAt: new Date().toISOString(),
  };
}

/** Moves a step to a new position. `to` is the index in the list AFTER removal. */
export function moveStep(draft: Draft, id: string, to: number): Draft {
  const from = draft.steps.findIndex((step) => step.id === id);
  if (from < 0) return draft;
  const steps = [...draft.steps];
  const [entry] = steps.splice(from, 1);
  if (!entry) return draft;
  steps.splice(Math.max(0, Math.min(to, steps.length)), 0, entry);
  return { ...draft, steps, updatedAt: new Date().toISOString() };
}

export function patchStep(draft: Draft, id: string, patch: Partial<DraftStep>): Draft {
  return {
    ...draft,
    steps: draft.steps.map((step) => (step.id === id ? { ...step, ...patch } : step)),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * The draft's team.
 *
 * An operator can only be removed together with their steps — otherwise the
 * actions of someone not in the team would remain, the simulation would
 * rightly flag them as errors, and the user would not see where they came
 * from.
 */
export function setTeam(draft: Draft, team: string[]): Draft {
  // Empty slots at the end are no slots at all.
  team = [...team];
  while (team.length > 0 && !team[team.length - 1]) team.pop();
  const allowed = new Set(team.filter(Boolean));
  return {
    ...draft,
    team,
    comboPriority: (draft.comboPriority ?? []).filter((key) => allowed.has(key)),
    steps: draft.steps.filter((step) => allowed.has(step.actor)),
    updatedAt: new Date().toISOString(),
  };
}
