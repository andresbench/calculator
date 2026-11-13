/**
 * Builds and drafts that come from outside the code: IndexedDB, an imported
 * file. They were written by an older version of the app, by hand, or by
 * someone else, so nothing about their shape is known — and one build
 * without `gear` is enough for the track to throw while rendering, and for the
 * page to stay white after every reload, because the broken state is what the
 * page loads.
 *
 * The rule is the same everywhere: take what is valid, fill the rest from
 * the empty one (`emptyBuild`, `emptyDraft`), drop what cannot stand alone.
 * Fields this file has never heard of are kept as they came: a field added to
 * `Build` later must not vanish from a saved build only because this checker
 * was not updated.
 */

import { emptyBuild, type Build } from './build.js';
import type { Provenance, TalentNodes } from './bundle.js';
import { emptyDraft, type Draft, type DraftStep } from './draft.js';
import type { ActionKind } from './timing.js';

/** A named build variant: "Will", "Intellect". */
export interface BuildVariant {
  id: string;
  name: string;
  build: Build;
  savedAt: string;
}

/**
 * One operator's build variants.
 *
 * The showcase is not in the list: it is assembled from the roster on the
 * fly, read-only, and `active: null` means "looking at the showcase".
 */
export interface OperatorBuilds {
  active: string | null;
  variants: BuildVariant[];
}

const ACTION_KINDS: readonly ActionKind[] = ['BA', 'FS', 'FIN', 'DIVE', 'BS', 'CS', 'ULT', 'DODGE', 'WAIT'];
const PROVENANCE: readonly string[] = ['profile', 'manual', 'default'] satisfies Provenance[];
const GEAR_SLOTS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function text(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function numberOr(value: unknown, fallback: number): number {
  return isNumber(value) ? value : fallback;
}

function gearSlot(value: unknown): Build['gear'][number] {
  if (!isRecord(value) || !text(value.key)) return null;
  return { key: value.key, tier: numberOr(value.tier, 0) };
}

function talentNodes(value: unknown): TalentNodes | null {
  if (!isRecord(value) || !isNumber(value.attribute) || !Array.isArray(value.passive)) return null;
  if (!value.passive.every(isNumber)) return null;
  return { attribute: value.attribute, passive: [...value.passive] };
}

function weaponColumns(value: unknown): Record<string, number | null> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number | null> = {};
  for (const [key, level] of Object.entries(value)) {
    if (level === null || isNumber(level)) out[key] = level;
  }
  return out;
}

/**
 * Anything that should be a build, as a build; `null` when it is not one.
 *
 * `fallbackKey` is for the places that know the operator from elsewhere (the
 * key a build is stored under): a build without `operatorKey` takes it.
 */
export function normaliseBuild(raw: unknown, fallbackKey?: string): Build | null {
  if (!isRecord(raw)) return null;
  const operatorKey = text(raw.operatorKey) ? raw.operatorKey : fallbackKey;
  if (!text(operatorKey)) return null;
  const base = emptyBuild(operatorKey);

  const skills = isRecord(raw.skills) ? raw.skills : {};
  const provenance: Record<string, Provenance> = { ...base.provenance };
  if (isRecord(raw.provenance)) {
    for (const [field, source] of Object.entries(raw.provenance)) {
      if (typeof source === 'string' && PROVENANCE.includes(source)) provenance[field] = source as Provenance;
    }
  }
  const gear = Array.isArray(raw.gear) ? raw.gear : [];

  const { weaponColumns: columns, talentNodes: nodes, ...rest } = raw;
  const out: Build = {
    ...rest,
    operatorKey,
    level: numberOr(raw.level, base.level),
    elite: numberOr(raw.elite, base.elite),
    potential: numberOr(raw.potential, base.potential),
    skills: {
      basic: numberOr(skills.basic, base.skills.basic),
      battle: numberOr(skills.battle, base.skills.battle),
      combo: numberOr(skills.combo, base.skills.combo),
      ultimate: numberOr(skills.ultimate, base.skills.ultimate),
    },
    weaponKey: text(raw.weaponKey) ? raw.weaponKey : null,
    weaponLevel: numberOr(raw.weaponLevel, base.weaponLevel),
    gear: Array.from({ length: GEAR_SLOTS }, (_, index) => gearSlot(gear[index])),
    provenance,
  };
  const validColumns = weaponColumns(columns);
  if (validColumns) out.weaponColumns = validColumns;
  const validNodes = talentNodes(nodes);
  if (validNodes) out.talentNodes = validNodes;
  return out;
}

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : null;
}

function draftStep(raw: unknown): DraftStep | null {
  if (!isRecord(raw) || !text(raw.id) || !text(raw.actor)) return null;
  if (!ACTION_KINDS.includes(raw.kind as ActionKind)) return null;
  const { seconds, ...rest } = raw;
  const out: DraftStep = {
    ...rest,
    id: raw.id,
    actor: raw.actor,
    kind: raw.kind as ActionKind,
    sequence: isNumber(raw.sequence) ? raw.sequence : null,
    optional: raw.optional === true,
    uncertain: raw.uncertain === true,
    note: typeof raw.note === 'string' ? raw.note : null,
    cycle: numberOr(raw.cycle, 1),
  };
  if (isNumber(seconds)) out.seconds = seconds;
  return out;
}

/**
 * Anything that should be a rotation draft, as a draft; `null` when it is
 * not one. A step that is not a step is dropped, the rest of the draft stays.
 */
export function normaliseDraft(raw: unknown, fallbackId?: string): Draft | null {
  if (!isRecord(raw)) return null;
  const id = text(raw.id) ? raw.id : fallbackId;
  if (!text(id)) return null;
  const base = emptyDraft();

  const { comboPriority, ultimatesCharged, unlimitedSp, controlled, ...rest } = raw;
  const out: Draft = {
    ...rest,
    id,
    title: typeof raw.title === 'string' ? raw.title : base.title,
    team: stringList(raw.team) ?? [],
    variant: typeof raw.variant === 'string' ? raw.variant : null,
    steps: Array.isArray(raw.steps) ? raw.steps.flatMap((step) => draftStep(step) ?? []) : [],
    enemyKey: typeof raw.enemyKey === 'string' ? raw.enemyKey : null,
    origin: typeof raw.origin === 'string' ? raw.origin : null,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
  };
  const priority = stringList(comboPriority);
  if (priority) out.comboPriority = priority;
  if (typeof ultimatesCharged === 'boolean') out.ultimatesCharged = ultimatesCharged;
  if (typeof unlimitedSp === 'boolean') out.unlimitedSp = unlimitedSp;
  if (text(controlled)) out.controlled = controlled;
  return out;
}

/** Saved drafts, by id: the ones that are not drafts are left out. */
export function normaliseDrafts(raw: unknown): Record<string, Draft> {
  const out: Record<string, Draft> = {};
  if (!isRecord(raw)) return out;
  for (const [key, value] of Object.entries(raw)) {
    const draft = normaliseDraft(value, key);
    if (draft) out[draft.id] = draft;
  }
  return out;
}

/**
 * Saved build variants, by operator key. A variant whose build is not a build
 * is dropped, an operator left with none disappears, and an `active` that
 * names nothing becomes the showcase (`null`).
 */
export function normaliseVariants(raw: unknown): Record<string, OperatorBuilds> {
  const out: Record<string, OperatorBuilds> = {};
  if (!isRecord(raw)) return out;
  for (const [key, entry] of Object.entries(raw)) {
    if (!isRecord(entry) || !Array.isArray(entry.variants)) continue;
    const variants: BuildVariant[] = [];
    const seen = new Set<string>();
    for (const item of entry.variants) {
      if (!isRecord(item) || !text(item.id) || seen.has(item.id)) continue;
      const build = normaliseBuild(item.build, key);
      if (!build) continue;
      seen.add(item.id);
      variants.push({
        id: item.id,
        name: text(item.name) ? item.name : item.id,
        build,
        savedAt: typeof item.savedAt === 'string' ? item.savedAt : new Date(0).toISOString(),
      });
    }
    if (variants.length === 0) continue;
    const active = typeof entry.active === 'string' && seen.has(entry.active) ? entry.active : null;
    out[key] = { active, variants };
  }
  return out;
}
