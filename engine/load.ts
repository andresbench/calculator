/**
 * The built bundle from disk, for the command-line tools (`cli.ts`, `sim.ts`).
 *
 * Node-only, so it lives outside `src/`: the engine itself has no file
 * system. `roster.json` next to the bundle is attached when present — the
 * CLI plays the user's own roster; a public build has none.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assertBundle, attachRoster, type Bundle } from './src/index.js';

const DATA = fileURLToPath(new URL('../app/public/data/', import.meta.url));

export function loadBundle(): Bundle {
  const path = `${DATA}bundle.json`;
  if (!existsSync(path)) {
    console.error('Bundle not built. Run: python3 tools/ef/export.py');
    process.exit(1);
  }
  const payload: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assertBundle(payload);
  const roster = `${DATA}roster.json`;
  if (existsSync(roster)) attachRoster(payload, JSON.parse(readFileSync(roster, 'utf8')));
  return payload;
}
