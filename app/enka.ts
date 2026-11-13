/**
 * Roster import from an Enka.Network showcase, served by the local dev server.
 *
 * The browser cannot do this alone, and should not: the showcase is parsed
 * by `tools/ef/profile.py` (operator ids, weapon and gear icons, Essence
 * terms) and turned into numbers by `tools/ef/export.py`. A second parser in
 * TypeScript would drift from the first on the next patch, so the endpoint
 * runs exactly the commands one would type:
 *
 *     python3 tools/ef/profile.py fetch <link> --json
 *     python3 tools/ef/export.py
 *
 * and the page reloads the bundle afterwards. Only the dev server has this
 * (`npm run dev`, or the desktop launcher `app/launch.sh`); a static build
 * answers 404 and the page says so.
 *
 * Arguments go to `execFile` as an array, never through a shell, and the
 * Python side accepts only a UID or an `enka.network/ef/<UID>` link.
 */

import { execFile } from 'node:child_process';
import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath, URL } from 'node:url';

import type { Plugin } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PROFILE_DIR = `${ROOT}data/endfield/profile`;
const PYTHON = process.env.PYTHON ?? 'python3';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(PYTHON, args, { cwd: ROOT, timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
      resolve({ code, stdout, stderr: stderr || (error && !stdout ? error.message : '') });
    });
  });
}

/** Showcases imported before: UID and the time of the latest snapshot. */
function knownShowcases(): Array<{ uid: string; link: string; lastImport: string | null }> {
  let uids: string[] = [];
  try {
    uids = readdirSync(`${PROFILE_DIR}/snapshots`);
  } catch {
    return [];
  }
  return uids.map((uid) => {
    let last: string | null = null;
    try {
      const names = readdirSync(`${PROFILE_DIR}/snapshots/${uid}`).filter((name) => name.endsWith('.json'));
      const latest = names.sort().at(-1);
      // 20261015T222014Z.json → 2026-10-15T22:20:14Z
      const match = latest?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
      if (match) last = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`;
    } catch {
      // A UID folder without snapshots is still a known UID.
    }
    return { uid, link: `https://enka.network/ef/${uid}/`, lastImport: last };
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf8');
      if (data.length > 4096) reject(new Error('request too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export function enkaImport(): Plugin {
  // One import at a time: two would race on the profile store and the bundle.
  let busy = false;

  return {
    name: 'enka-import',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/api/roster', (req, res, next) => {
        const path = (req.url ?? '/').split('?')[0];

        if (req.method === 'GET' && (path === '/' || path === '')) {
          send(res, 200, { available: true, busy, showcases: knownShowcases() });
          return;
        }

        if (req.method === 'POST' && path === '/import') {
          // Only the page served by this dev server may start an import: a
          // "simple" cross-site POST (text/plain, no preflight) from any tab
          // would otherwise run profile.py and rewrite the roster.
          const origin = req.headers.origin ?? '';
          const type = req.headers['content-type'] ?? '';
          if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || !type.startsWith('application/json')) {
            send(res, 403, { ok: false, error: 'imports start from the calculator page only' });
            return;
          }
          void (async () => {
            if (busy) {
              send(res, 409, { ok: false, error: 'an import is already running' });
              return;
            }
            busy = true;
            try {
              const body = JSON.parse((await readBody(req)) || '{}') as { source?: unknown };
              const source = typeof body.source === 'string' ? body.source.trim() : '';
              if (!source) {
                send(res, 400, { ok: false, error: 'paste a UID or a showcase link' });
                return;
              }

              // `--` keeps a source starting with «-» from reading as an option.
              const fetched = await run(['tools/ef/profile.py', 'fetch', '--json', '--', source], 90_000);
              let report: Record<string, unknown>;
              try {
                report = JSON.parse(fetched.stdout.trim().split('\n').at(-1) ?? '') as Record<string, unknown>;
              } catch {
                send(res, 500, { ok: false, error: 'profile.py gave no report', log: fetched.stderr });
                return;
              }
              if (!report.ok) {
                send(res, 422, { ...report, log: fetched.stderr });
                return;
              }

              const exported = await run(['tools/ef/export.py'], 120_000);
              if (exported.code !== 0) {
                send(res, 500, {
                  ok: false,
                  error: 'the showcase was imported, but rebuilding the bundle failed',
                  report,
                  log: `${exported.stdout}\n${exported.stderr}`,
                });
                return;
              }
              send(res, 200, { ...report, log: fetched.stderr });
            } catch (error) {
              send(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            } finally {
              busy = false;
            }
          })();
          return;
        }

        next();
      });
    },
  };
}
