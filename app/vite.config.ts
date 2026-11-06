import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { enkaImport } from './enka';

/**
 * A short hash of the bundle the build ships with. The page asks for
 * `bundle.json?v=<hash>`: hosting caches files for minutes, and a fresh build
 * must not meet yesterday's bundle (it would fail the schema check).
 */
function bundleVersion(): string {
  const path = fileURLToPath(new URL('./public/data/bundle.json', import.meta.url));
  if (!existsSync(path)) return '';
  return createHash('sha1').update(readFileSync(path)).digest('hex').slice(0, 12);
}

/** The commit the build comes from: CI gives `GITHUB_SHA`, locally ask git. */
function buildCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

export default defineConfig(({ command }) => ({
  define: {
    __BUNDLE_VERSION__: JSON.stringify(command === 'build' ? bundleVersion() : ''),
    __BUILD_COMMIT__: JSON.stringify(command === 'build' ? buildCommit() : ''),
  },
  // enkaImport: roster refresh from an Enka showcase, dev server only.
  plugins: [react(), enkaImport()],
  resolve: {
    alias: {
      // The engine is linked as source, not as a built package: one copy of
      // the code for the app and the tests, no build step in between.
      '@engine': fileURLToPath(new URL('../engine/src', import.meta.url)),
    },
  },
  server: { port: 5173, open: false },
}));
