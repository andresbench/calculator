/**
 * The roster from an Enka showcase, on the static site (PUBLISH_PLAN, stage P6).
 *
 * The showcase comes through the project's proxy — Enka sends no CORS
 * headers — and the engine reads it (`showcase.ts`) with the bundle's
 * tables. The result stays in this browser (IndexedDB) and accumulates the
 * way `tools/ef/profile.py` does: the showcase lists only who is on display,
 * so operators seen earlier are kept until the player imports again.
 *
 * Locally the dev server's import (`app/enka.ts`) writes `roster.json`
 * instead, and that file wins: see `data.ts`.
 */

import { del as idbDel, get as idbGet, set as idbSet } from 'idb-keyval';

import { readShowcase, uidFromSource, type Bundle, type Roster, type RosterEntry, type ShowcasePayload } from '@engine/index.js';

/** `GET <PROXY><UID>` → Enka's `/api/ef/uid/<UID>`, cached there for 60 s. */
export const PROXY = 'https://enka.andresbench.moe/api/ef/uid/';

const KEY = 'endfield.showcase.v1';

export interface StoredShowcase {
  uid: string;
  nickname: string | null;
  lastImport: string;
  operators: Record<string, RosterEntry>;
  /** When each operator was last on the showcase. */
  seen: Record<string, string>;
}

/** The same shape as the dev server's report (`profile.py fetch --json`), so one panel shows both. */
export interface ShowcaseReport {
  ok: boolean;
  code?: string;
  error?: string;
  uid?: string;
  nickname?: string | null;
  showcase?: string[];
  new?: string[];
  changed?: string[];
  unchanged?: string[];
  kept?: string[];
  unknown?: unknown[];
  unresolved?: string[];
}

export async function loadShowcase(): Promise<StoredShowcase | null> {
  try {
    return ((await idbGet(KEY)) as StoredShowcase | undefined) ?? null;
  } catch {
    return null;
  }
}

/** The stored showcase as the bundle's roster. */
export function asRoster(stored: StoredShowcase): Roster {
  return { operators: stored.operators, defaults: {} };
}

export async function forgetShowcase(): Promise<void> {
  try {
    await idbDel(KEY);
  } catch {
    // Nothing stored, or storage blocked: nothing to forget either way.
  }
}

/** Fetches a showcase through the proxy, reads it and merges it into the stored roster. */
export async function importShowcase(source: string, bundle: Bundle): Promise<ShowcaseReport> {
  const parsed = uidFromSource(source);
  if ('failure' in parsed) return { ok: false, code: parsed.failure };
  const { uid } = parsed;

  let payload: ShowcasePayload;
  try {
    const response = await fetch(`${PROXY}${uid}`);
    if (!response.ok) return { ok: false, code: `http_${response.status}` };
    payload = (await response.json()) as ShowcasePayload;
  } catch {
    return { ok: false, code: 'network' };
  }

  // Someone else's JSON, and a proxy that passes through whatever Enka sent: `null`, `charData: {}` and the like throw.
  let read: ReturnType<typeof readShowcase>;
  try {
    read = readShowcase(payload, bundle);
  } catch {
    return { ok: false, code: 'bad_payload' };
  }
  const before = await loadShowcase();
  // Another account starts over: two players' operators are not one roster.
  const previous = before && before.uid === uid ? before : null;
  const operators: Record<string, RosterEntry> = { ...(previous?.operators ?? {}) };
  const seen: Record<string, string> = { ...(previous?.seen ?? {}) };
  const now = new Date().toISOString();
  const report: Required<Pick<ShowcaseReport, 'new' | 'changed' | 'unchanged'>> = { new: [], changed: [], unchanged: [] };
  for (const [key, entry] of Object.entries(read.entries)) {
    const old = operators[key];
    if (!old) report.new.push(key);
    else if (JSON.stringify(old) !== JSON.stringify(entry)) report.changed.push(key);
    else report.unchanged.push(key);
    operators[key] = entry;
    seen[key] = now;
  }
  const showcase = Object.keys(read.entries).sort();
  const kept = Object.keys(operators).filter((key) => !read.entries[key]).sort();

  try {
    await idbSet(KEY, { uid, nickname: read.nickname, lastImport: now, operators, seen } satisfies StoredShowcase);
  } catch {
    // A private window: the import still shows, it just will not survive a reload.
  }
  return {
    ok: true,
    uid,
    nickname: read.nickname,
    showcase,
    ...report,
    kept,
    unknown: read.unknown,
    unresolved: read.unresolved,
  };
}
