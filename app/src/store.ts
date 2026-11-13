/**
 * App state and its persistence.
 *
 * Storage is the browser only, with no server and no logins: IndexedDB plus
 * export to a file. The Enka showcase roster arrives ready-made in the
 * bundle, and edits on top of it live here — as named variants per
 * operator.
 */

import { get as idbGet, set as idbSet } from 'idb-keyval';
import { create } from 'zustand';

import {
  emptyDraft,
  normaliseBuild,
  normaliseDrafts,
  normaliseVariants,
  showcaseBuild,
  type Build,
  type BuildVariant,
  type Bundle,
  type Draft,
  type DummyState,
  type OperatorBuilds,
} from '@engine/index.js';

import { currentT } from './i18n/index.js';

/** Before 2026-10-29: one build per operator. Read only for migration. */
const LEGACY_KEY = 'endfield.builds.v1';
const STORAGE_KEY = 'endfield.builds.v2';
const DRAFTS_KEY = 'endfield.rotations.v1';

// What is saved is read through the engine's checkers (`normalise.ts`): a
// build that is not a build must not reach the track, or the page stays white
// on every load. The types live there with them.
export type { BuildVariant, OperatorBuilds };

interface AppState {
  /** Saved variants, by operator key. This is what gets stored. */
  variants: Record<string, OperatorBuilds>;
  /**
   * The active variant, unless it is the showcase — derived from
   * `variants`. Kept in state for stable selectors: the track and the roster
   * read it and do not care how many variants sit behind it.
   */
  builds: Record<string, Build>;
  selected: string | null;
  dummy: DummyState;
  /** Rotation drafts: the app never rewrites files in `rotations/`. */
  drafts: Record<string, Draft>;
  loaded: boolean;

  hydrate: () => Promise<void>;
  select: (key: string | null) => void;
  /** The active variant, else the roster showcase, else an empty build. */
  buildFor: (key: string, bundle: Bundle) => Build;
  /** Edits the active variant. Never edits the showcase: see `ensureEditable`. */
  update: (key: string, patch: Partial<Build>) => void;
  /** Back to the showcase. Saved variants stay. */
  reset: (key: string) => void;
  selectVariant: (key: string, id: string | null) => void;
  /** The current build as a new variant with this name; it becomes active. */
  saveAs: (key: string, name: string, bundle: Bundle) => void;
  renameVariant: (key: string, id: string, name: string) => void;
  deleteVariant: (key: string, id: string) => void;
  /** Everyone back to the showcase builds, nothing deleted: the way out of a screen that crashed on a saved build. */
  resetToShowcase: () => void;
  /** Erases every saved variant and draft of this browser: the last way out of a crash. */
  eraseSaved: () => void;
  setDummy: (patch: Partial<DummyState>) => void;
  newDraft: () => Draft;
  saveDraft: (draft: Draft) => void;
  deleteDraft: (id: string) => void;
  exportJson: () => string;
  /** Returns the number of imported variants. */
  importJson: (text: string) => number;
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function variant(name: string, build: Build): BuildVariant {
  return { id: newId(), name, build, savedAt: new Date().toISOString() };
}

/** `builds` from `variants`: each operator's active variant. */
function activeBuilds(variants: Record<string, OperatorBuilds>): Record<string, Build> {
  const out: Record<string, Build> = {};
  for (const [key, entry] of Object.entries(variants)) {
    const active = entry.variants.find((item) => item.id === entry.active);
    if (active) out[key] = active.build;
  }
  return out;
}

/** The old format — one build per operator — into variants. Whatever is not a build is left out. */
function migrate(legacy: unknown, name: string): Record<string, OperatorBuilds> {
  const out: Record<string, OperatorBuilds> = {};
  if (typeof legacy !== 'object' || legacy === null) return out;
  for (const [key, raw] of Object.entries(legacy)) {
    const build = normaliseBuild(raw, key);
    if (!build) continue;
    const item = variant(name, build);
    out[key] = { active: item.id, variants: [item] };
  }
  return out;
}

async function persist(variants: Record<string, OperatorBuilds>): Promise<void> {
  try {
    await idbSet(STORAGE_KEY, variants);
  } catch {
    // A private window or blocked site data. Losing edits is unpleasant,
    // but the app must not crash over it.
  }
}

async function persistDrafts(drafts: Record<string, Draft>): Promise<void> {
  try {
    await idbSet(DRAFTS_KEY, drafts);
  } catch {
    // Same reason as for builds: a private window must not crash the app,
    // but pretending it saved is not allowed either.
  }
}

export const useApp = create<AppState>((set, getState) => {
  /** Writes variants: state, derived state and IndexedDB at once. */
  const commit = (variants: Record<string, OperatorBuilds>): void => {
    set({ variants, builds: activeBuilds(variants) });
    void persist(variants);
  };

  const entryOf = (key: string): OperatorBuilds =>
    getState().variants[key] ?? { active: null, variants: [] };

  return {
    variants: {},
    builds: {},
    drafts: {},
    selected: null,
    dummy: { enemyKey: null, tier: 5, staggered: false, crit: false, assume: {} },
    loaded: false,

    hydrate: async () => {
      let saved: unknown;
      let legacy: unknown;
      let drafts: unknown;
      try {
        saved = await idbGet(STORAGE_KEY);
        if (!saved) legacy = await idbGet(LEGACY_KEY);
        drafts = await idbGet(DRAFTS_KEY);
      } catch {
        saved = undefined;
        drafts = undefined;
      }
      // Old edits become the first variant. The v1 key is not erased: rolling
      // back to the previous app version loses nothing.
      const variants = saved ? normaliseVariants(saved) : legacy ? migrate(legacy, currentT().variants.edited) : {};
      if (!saved && legacy) void persist(variants);
      set({ variants, builds: activeBuilds(variants), drafts: normaliseDrafts(drafts), loaded: true });
    },

    select: (key) => set({ selected: key }),

    buildFor: (key, bundle) => {
      return getState().builds[key] ?? showcaseBuild(key, bundle);
    },

    update: (key, patch) => {
      const entry = entryOf(key);
      const current = entry.variants.find((item) => item.id === entry.active);
      if (!current) return;
      const next = { ...current, build: { ...current.build, ...patch }, savedAt: new Date().toISOString() };
      commit({
        ...getState().variants,
        [key]: { ...entry, variants: entry.variants.map((item) => (item.id === next.id ? next : item)) },
      });
    },

    reset: (key) => getState().selectVariant(key, null),

    selectVariant: (key, id) => {
      const entry = entryOf(key);
      if (id !== null && !entry.variants.some((item) => item.id === id)) return;
      commit({ ...getState().variants, [key]: { ...entry, active: id } });
    },

    saveAs: (key, name, bundle) => {
      const entry = entryOf(key);
      const item = variant(
        name.trim() || currentT().variants.numbered(entry.variants.length + 1),
        getState().buildFor(key, bundle),
      );
      commit({ ...getState().variants, [key]: { active: item.id, variants: [...entry.variants, item] } });
    },

    renameVariant: (key, id, name) => {
      const entry = entryOf(key);
      const trimmed = name.trim();
      if (!trimmed) return;
      commit({
        ...getState().variants,
        [key]: {
          ...entry,
          variants: entry.variants.map((item) => (item.id === id ? { ...item, name: trimmed } : item)),
        },
      });
    },

    deleteVariant: (key, id) => {
      const entry = entryOf(key);
      const variants = { ...getState().variants };
      const rest = entry.variants.filter((item) => item.id !== id);
      if (rest.length === 0) delete variants[key];
      else variants[key] = { active: entry.active === id ? null : entry.active, variants: rest };
      commit(variants);
    },

    resetToShowcase: () => {
      const variants = Object.fromEntries(
        Object.entries(getState().variants).map(([key, entry]) => [key, { ...entry, active: null }]),
      );
      commit(variants);
      set({ selected: null });
    },

    eraseSaved: () => {
      commit({});
      set({ drafts: {}, selected: null });
      void persistDrafts({});
    },

    setDummy: (patch) => set({ dummy: { ...getState().dummy, ...patch } }),

    newDraft: () => {
      const draft = emptyDraft();
      const drafts = { ...getState().drafts, [draft.id]: draft };
      set({ drafts });
      void persistDrafts(drafts);
      return draft;
    },

    saveDraft: (draft) => {
      const drafts = { ...getState().drafts, [draft.id]: draft };
      set({ drafts });
      void persistDrafts(drafts);
    },

    deleteDraft: (id) => {
      const drafts = { ...getState().drafts };
      delete drafts[id];
      set({ drafts });
      void persistDrafts(drafts);
    },

    exportJson: () =>
      JSON.stringify(
        {
          version: 3,
          savedAt: new Date().toISOString(),
          variants: getState().variants,
          drafts: getState().drafts,
        },
        null,
        2,
      ),

    importJson: (text) => {
      const payload: unknown = JSON.parse(text);
      if (typeof payload !== 'object' || payload === null) throw new Error(currentT().roster.importNotObject);
      const file = payload as { variants?: unknown; builds?: unknown; drafts?: unknown };
      // The file is someone else's, or an older version's, or edited by hand:
      // what is not a build or a draft is left out, the rest is repaired.
      // Versions 1–2 stored one build per operator: they arrive as an
      // "Imported" variant, overwriting nothing.
      const incoming =
        file.variants && typeof file.variants === 'object'
          ? normaliseVariants(file.variants)
          : file.builds && typeof file.builds === 'object'
            ? migrate(file.builds, currentT().variants.imported)
            : null;
      if (!incoming) throw new Error(currentT().roster.importNoBuilds);

      // A variant with the same id is replaced, the rest are added; the one
      // active in the file becomes active.
      const variants = { ...getState().variants };
      let count = 0;
      for (const [key, entry] of Object.entries(incoming)) {
        const mine = variants[key] ?? { active: null, variants: [] };
        const ids = new Set(entry.variants.map((item) => item.id));
        variants[key] = {
          active: entry.active ?? mine.active,
          variants: [...mine.variants.filter((item) => !ids.has(item.id)), ...entry.variants],
        };
        count += entry.variants.length;
      }
      commit(variants);

      // Rotation drafts appeared in the file's second version: older files
      // import as they are, without them.
      if (file.drafts && typeof file.drafts === 'object') {
        const drafts = { ...getState().drafts, ...normaliseDrafts(file.drafts) };
        set({ drafts });
        void persistDrafts(drafts);
      }
      return count;
    },
  };
});

/**
 * Makes the active variant editable.
 *
 * The showcase is a snapshot from the game, and editing does not change it:
 * the first edit creates a "Custom" variant from what is on the showcase,
 * and from then on the editor edits that.
 */
export function ensureEditable(key: string, bundle: Bundle): Build {
  const state = useApp.getState();
  const existing = state.builds[key];
  if (existing) return existing;
  const taken = new Set((state.variants[key]?.variants ?? []).map((item) => item.name));
  const names = currentT().variants;
  let name = names.custom;
  for (let index = 2; taken.has(name); index += 1) name = names.customNumbered(index);
  state.saveAs(key, name, bundle);
  return useApp.getState().builds[key]!;
}
