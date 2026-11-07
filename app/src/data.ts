/**
 * Bundle loading.
 *
 * The app does not read `data/endfield/*.json` directly — only the build from
 * `tools/ef/export.py`. Numbers there carry explicit units, and that is the
 * only place where it is decided what counts as a percentage.
 */

import { useEffect, useState } from 'react';

import { assertBundle, attachRoster, type Bundle } from '@engine/index.js';

import { asRoster, loadShowcase } from './showcaseRoster.js';

/**
 * In a build the URL carries the bundle's hash, so a cached copy from the
 * previous deploy is never read. The dev server rewrites the file in place
 * (Enka import), so there it is always fetched fresh.
 */
const VERSION = typeof __BUNDLE_VERSION__ === 'string' ? __BUNDLE_VERSION__ : '';
const BUNDLE_URL = VERSION ? `data/bundle.json?v=${VERSION}` : 'data/bundle.json';
const CACHE: RequestCache = import.meta.env?.DEV ? 'no-store' : 'default';

/**
 * The user's own roster, written next to the bundle by `export.py` for local
 * use. A public build has none: there a showcase imported in this browser
 * stands in (`showcaseRoster.ts`), and the page works without either.
 */
async function loadRoster(bundle: Bundle): Promise<void> {
  try {
    const response = await fetch('data/roster.json', { cache: 'no-store' });
    if (response.ok && attachRoster(bundle, await response.json())) return;
  } catch {
    // No roster is a normal state, not an error.
  }
  // The site has no roster.json: a showcase imported in this browser stands in.
  const stored = await loadShowcase();
  if (stored) bundle.roster = asRoster(stored);
}

export type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; bundle: Bundle }
  | { status: 'error'; message: string };

/**
 * The bundle, plus a way to read it again.
 *
 * `reload` exists for the Enka import: the dev server rewrites
 * `bundle.json` in place, and the page picks it up without a full refresh,
 * so unsaved state in the editor survives. The current bundle stays on
 * screen while the new one loads.
 */
export function useBundle(): LoadState & { reload: () => void } {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(BUNDLE_URL, { cache: CACHE });
        if (!response.ok) {
          throw new Error(
            `${response.status} ${response.statusText}. ` +
              'Build the bundle: python3 tools/ef/export.py',
          );
        }
        const payload: unknown = await response.json();
        assertBundle(payload);
        await loadRoster(payload);
        if (!cancelled) setState({ status: 'ready', bundle: payload });
      } catch (error) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [generation]);

  return { ...state, reload: () => setGeneration((value) => value + 1) };
}

/** Icon path inside public. A missing icon is normal, not an error. */
export function iconUrl(path: string | null): string | undefined {
  return path ? encodeURI(path) : undefined;
}

/**
 * The player's character comes as two operator records that differ only in
 * gender (and a frame in the client's combo window). Lists show one — the
 * female Endministrator, on whom the measurements were made — unless the
 * account has the other. Rotations and drafts with either key still play.
 */
const TWIN_HIDDEN = new Set(['Endministrator (male)']);

export function listed(key: string, owned: ReadonlySet<string> | readonly string[] = []): boolean {
  const has = Array.isArray(owned) ? owned.includes(key) : (owned as ReadonlySet<string>).has(key);
  return !TWIN_HIDDEN.has(key) || has;
}
