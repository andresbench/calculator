/**
 * Bundle loading.
 *
 * The app does not read `data/endfield/*.json` directly — only the build from
 * `tools/ef/export.py`. Numbers there carry explicit units, and that is the
 * only place where it is decided what counts as a percentage.
 */

import { useEffect, useState } from 'react';

import { assertBundle, attachRoster, type Bundle } from '@engine/index.js';

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
 * use. A public build has none, and the page works without it.
 */
async function loadRoster(bundle: Bundle): Promise<void> {
  try {
    const response = await fetch('data/roster.json', { cache: 'no-store' });
    if (response.ok) attachRoster(bundle, await response.json());
  } catch {
    // No roster is a normal state, not an error.
  }
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
