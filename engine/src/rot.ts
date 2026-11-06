/**
 * Parser for the `.rot` rotation notation.
 *
 * A port of the format from `tools/ef/rotation.py`. Both parsers live on on
 * purpose: a test runs every file in `rotations/` through the engine and
 * checks the steps are the same. If they drift, one of the two is wrong,
 * and it shows.
 *
 * ```
 * # comment
 * title: Breach core
 * team: Lifeng, Chen Qianyu, Pogranichnik, Mi Fu
 * priority: Chen Qianyu, Mi Fu   # optional: combo priority from game settings
 * controlled: Lifeng             # optional: who is controlled before the first step
 *
 * variant: basic
 * cycle 1:
 * Lifeng: BS         [clean target, so Knock Down gives a stack]
 * Chen Qianyu: CS > BS
 * ```
 *
 * Actions: `BA` `FS` `FIN` `DIVE` `BS` `CS` `ULT`, with an optional stage
 * number (`BS2`, `CS1`) and the modifiers `~` (optional step) and `?`
 * (questionable, check by hand). Two fillers take time and nothing else:
 * `DODGE` (a perfect dodge) and `WAIT 2.5s` (a pause of that length). The
 * cycle header also accepts the Russian `цикл`.
 *
 * `team:` keeps empty slots as `-`: `team: Lifeng, -, -, Endministrator`
 * puts the Endministrator in slot 04, and the game reads slots.
 */

import type { Message } from './messages.js';
import type { Bundle } from './bundle.js';
import type { ActionKind } from './timing.js';

export interface RotStep {
  index: number;
  /** The name as written in the file: localised, abbreviated, anything. */
  actorRaw: string;
  /** The canonical operator key, if it could be identified. */
  actor: string | null;
  kind: ActionKind;
  /** Stage of a multi-stage skill: `BS2` → 2. */
  sequence: number | null;
  /** Length of a `WAIT`, in seconds. Absent for every other action. */
  seconds?: number | null;
  optional: boolean;
  uncertain: boolean;
  note: string | null;
  variant: string | null;
  cycle: number;
  line: number;
}

export interface Rotation {
  title: string | null;
  /**
   * The team in squad order: the first is slot 01. Names are resolved to
   * keys where possible; an unrecognised name stays as written.
   */
  team: string[];
  /**
   * Combo Skill Priority from the game settings: who casts first when
   * combos trigger at once. Empty means squad order, the game's default.
   */
  priority: string[];
  /** `ultimates: charged` — the fight starts with every ultimate charged. */
  ultimatesCharged?: boolean;
  /**
   * `controlled: Lifeng` — who is controlled before the first step. Without
   * it the engine picks (`controlledAtStart`).
   */
  controlled?: string;
  steps: RotStep[];
  variants: string[];
  warnings: Message[];
}

const ACTION_RE = /^(BA|FS|FIN|DIVE|BS|CS|ULT|DODGE)(\d+)?([~?]*)$/i;
const WAIT_RE = /^WAIT\s*(\d+(?:\.\d+)?)\s*s?([~?]*)$/i;
/** An empty team slot in the `team:` line. */
export const EMPTY_SLOT = '-';

/** Name normalisation: case, spaces, hyphens and apostrophes do not matter. */
export function normalise(name: string): string {
  return name.replace(/[\s_'-]+/g, '').toLowerCase();
}

/**
 * Parses a rotation file.
 *
 * `aliases` maps "normalised name → operator key". Without it the steps
 * still parse, but `actor` stays `null` and trigger checks cannot work.
 */
export function parseRot(text: string, aliases: Map<string, string> = new Map()): Rotation {
  const steps: RotStep[] = [];
  const warnings: Message[] = [];
  const variants: string[] = [];
  let title: string | null = null;
  let team: string[] = [];
  let priority: string[] = [];
  let ultimatesCharged = false;
  let controlled: string | null = null;
  let variant: string | null = null;
  let cycle = 1;
  let index = 0;

  const lines = text.split(/\r?\n/);

  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const raw = lines[lineNo]!;
    const line = raw.replace(/#.*$/, '').trim();
    if (line === '') continue;

    const header = /^(title|team|priority|variant|ultimates|controlled)\s*:\s*(.*)$/i.exec(line);
    if (header) {
      const value = header[2]!.trim();
      const key = header[1]!.toLowerCase();
      const names = (): string[] =>
        value
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => aliases.get(normalise(name)) ?? name);
      if (key === 'title') title = value;
      // An empty slot stays a hole, so the slots after it keep their numbers.
      else if (key === 'team') team = names().map((name) => (name === EMPTY_SLOT ? '' : name));
      else if (key === 'priority') priority = names();
      else if (key === 'ultimates') ultimatesCharged = value.toLowerCase() === 'charged';
      else if (key === 'controlled') controlled = names()[0] ?? null;
      else {
        variant = value;
        variants.push(value);
        // A new variant is a different way to play: the target state
        // resets and the cycle count starts over.
        cycle = 1;
      }
      continue;
    }

    const cycleHeader = /^(?:цикл|cycle)\s*(\d+)\s*:$/i.exec(line);
    if (cycleHeader) {
      cycle = Number(cycleHeader[1]);
      continue;
    }

    // A step line: "Chen Qianyu: BS > CS"; the actor may change mid-line.
    let note: string | null = null;
    const body = line.replace(/\[([^\]]*)\]\s*$/, (_match, captured: string) => {
      note = captured.trim();
      return '';
    }).trim();
    if (body === '') continue;

    let actorRaw: string | null = null;
    let matchedAny = false;

    for (const chunk of body.split('>')) {
      let token = chunk.trim();
      if (token === '') continue;

      const withActor = /^([^:]+):\s*(.*)$/.exec(token);
      if (withActor) {
        actorRaw = withActor[1]!.trim();
        token = withActor[2]!.trim();
        if (token === '') continue;
      }

      const pause = WAIT_RE.exec(token);
      const action = pause ? null : ACTION_RE.exec(token);
      if (!action && !pause) {
        warnings.push({ code: 'rotUnparsed', line: lineNo + 1, token });
        continue;
      }
      if (actorRaw === null) {
        warnings.push({ code: 'rotNoActor', line: lineNo + 1, token });
        continue;
      }

      matchedAny = true;
      index += 1;
      const modifiers = (pause ? pause[2] : action![3]) ?? '';
      steps.push({
        index,
        actorRaw,
        actor: aliases.get(normalise(actorRaw)) ?? null,
        kind: pause ? 'WAIT' : (action![1]!.toUpperCase() as ActionKind),
        sequence: !pause && action![2] ? Number(action![2]) : null,
        ...(pause ? { seconds: Number(pause[1]) } : {}),
        optional: modifiers.includes('~'),
        uncertain: modifiers.includes('?'),
        note,
        variant,
        cycle,
        line: lineNo + 1,
      });
    }

    if (!matchedAny && !/^[а-яёa-z\s]+:$/i.test(body)) {
      warnings.push({ code: 'rotNoAction', line: lineNo + 1 });
    }
  }

  for (const step of steps) {
    if (step.actor === null) {
      warnings.push({ code: 'rotUnknownOperator', step: step.index, actor: step.actorRaw });
    }
  }

  return {
    title,
    team,
    priority,
    ...(ultimatesCharged ? { ultimatesCharged } : {}),
    ...(controlled ? { controlled } : {}),
    steps,
    variants: [...new Set(variants)],
    warnings,
  };
}

/** Serialises back to `.rot`: a track from the app → a file in the repository. */
export function formatRot(rotation: Rotation, nameOf: (key: string) => string): string {
  const lines: string[] = [];
  if (rotation.title) lines.push(`title: ${rotation.title}`);
  if (rotation.team.length > 0) {
    lines.push(`team: ${rotation.team.map((key) => (key ? nameOf(key) : EMPTY_SLOT)).join(', ')}`);
  }
  if (rotation.priority.length > 0) {
    lines.push(`priority: ${rotation.priority.map(nameOf).join(', ')}`);
  }
  if (rotation.ultimatesCharged) lines.push('ultimates: charged');
  if (rotation.controlled) lines.push(`controlled: ${nameOf(rotation.controlled)}`);

  let variant: string | null | undefined;
  let cycle: number | undefined;

  for (const step of rotation.steps) {
    if (step.variant !== variant) {
      variant = step.variant;
      lines.push('');
      if (variant) lines.push(`variant: ${variant}`);
      cycle = undefined;
    }
    if (step.cycle !== cycle) {
      cycle = step.cycle;
      lines.push(`cycle ${cycle}:`);
    }
    const verb = step.kind === 'WAIT' ? `WAIT ${step.seconds ?? 0}s` : `${step.kind}${step.sequence ?? ''}`;
    const action = `${verb}${step.optional ? '~' : ''}${step.uncertain ? '?' : ''}`;
    const actor = step.actor ? nameOf(step.actor) : step.actorRaw;
    lines.push(`${actor}: ${action}${step.note ? `   [${step.note}]` : ''}`);
  }

  return lines.join('\n') + '\n';
}

/**
 * The operator alias map: "Chen" → `Chen Qianyu`.
 *
 * Without it, files in `rotations/` written with short or localised names
 * do not parse: `actor` stays `null` and there is nothing to check triggers
 * against.
 *
 * **A name can be ambiguous, and it is resolved the same way everywhere.**
 * The wiki has two Endministrators, male and female, with the same name —
 * only the key differs. Two paths through this map used to disagree: the
 * name overwrote itself (the last one won), while an alias from
 * `aliases.yaml` looked the name up and took the first match. So the same
 * operator, run through `formatRot` and parsed back, changed gender.
 *
 * Now there is one order: an exact key beats a name, and among equal names
 * the first by sorted key wins — so the choice does not depend on the
 * order of fields in the bundle.
 */
export function buildAliases(bundle: Bundle): Map<string, string> {
  const aliases = new Map<string, string>();
  const operators = Object.values(bundle.operators).sort((a, b) => a.key.localeCompare(b.key));

  // The key is the only unique thing; it takes priority.
  const byKey = new Set<string>();
  for (const operator of operators) {
    const key = normalise(operator.key);
    aliases.set(key, operator.key);
    byKey.add(key);
  }
  for (const operator of operators) {
    const name = normalise(operator.name);
    if (!aliases.has(name)) aliases.set(name, operator.key);
  }

  const canonicalKey = (canonical: string): string | undefined =>
    bundle.operators[canonical]?.key ??
    operators.find((operator) => operator.name === canonical)?.key;

  for (const [canonical, names] of Object.entries(bundle.aliases ?? {})) {
    const key = canonicalKey(canonical);
    if (!key) continue;
    // A hand-written alias beats a derived name but never touches a key:
    // "Endministrator (female)" must stay itself whatever aliases.yaml
    // says.
    for (const alias of names) {
      const normalised = normalise(alias);
      if (byKey.has(normalised)) continue;
      aliases.set(normalised, key);
    }
  }
  return aliases;
}
