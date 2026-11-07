/**
 * Refresh the roster from an Enka.Network showcase.
 *
 * Two ways, one report. Locally the dev server (`app/enka.ts`) runs
 * `tools/ef/profile.py` and `tools/ef/export.py`, and the roster lands in
 * the vault. On the site the page asks Enka through the project's proxy and
 * reads the showcase itself (`showcaseRoster.ts`); the roster stays in this
 * browser. With neither — no endpoint and no tables in the bundle — the
 * panel is not shown.
 *
 * Two things the report has to make plain, because both look like bugs
 * otherwise:
 *
 * * the showcase only lists operators that are on display in the game, so
 *   the import accumulates: rotate the showcase, import again, and the ones
 *   seen before stay;
 * * a saved build variant overrides the showcase while it is active, so
 *   freshly imported data shows only once the showcase is selected again.
 */

import { useEffect, useState } from 'react';

import type { Bundle } from '@engine/index.js';

import { currentT, useT } from './i18n/index.js';
import { forgetShowcase, importShowcase, loadShowcase, type ShowcaseReport } from './showcaseRoster.js';
import { useApp } from './store.js';

interface Showcase {
  uid: string;
  link: string;
  lastImport: string | null;
}

/** `profile.py --json`'s report, or the page's own (`showcaseRoster.ts`): the same shape. */
type Report = ShowcaseReport & { log?: string };

/** `server` — the local dev server; `proxy` — the site, through the Enka proxy. */
type Availability = 'checking' | 'server' | 'proxy' | 'unavailable';

/** Enka API codes, from its documentation; texts are in the dictionary. */
function failure(report: Report): string {
  const failures = currentT().enka.failures;
  return (report.code && failures[report.code]) ?? report.error ?? failures.unknown!;
}

export function EnkaImport({ bundle, onImported }: { bundle: Bundle; onImported: () => void }): JSX.Element {
  const builds = useApp((store) => store.builds);
  const reset = useApp((store) => store.reset);
  const [availability, setAvailability] = useState<Availability>('checking');
  const [showcases, setShowcases] = useState<Showcase[]>([]);
  const [source, setSource] = useState('');
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const t = useT();
  const te = t.enka;

  const refreshStatus = async (): Promise<void> => {
    try {
      const response = await fetch('/api/roster');
      const body = (await response.json()) as { available?: boolean; showcases?: Showcase[] };
      if (!response.ok || !body.available) throw new Error('no endpoint');
      setAvailability('server');
      setShowcases(body.showcases ?? []);
      setSource((current) => current || body.showcases?.[0]?.link || '');
    } catch {
      if (!bundle.showcase) {
        setAvailability('unavailable');
        return;
      }
      setAvailability('proxy');
      const stored = await loadShowcase();
      const link = stored ? `https://enka.network/ef/${stored.uid}/` : '';
      setShowcases(stored ? [{ uid: stored.uid, link, lastImport: stored.lastImport }] : []);
      setSource((current) => current || link);
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const name = (key: string): string => bundle.operators[key]?.name ?? key;

  const submit = async (): Promise<void> => {
    setRunning(true);
    setReport(null);
    if (availability === 'proxy') {
      const body = await importShowcase(source, bundle);
      setReport(body);
      if (body.ok) {
        onImported();
        void refreshStatus();
      }
      setRunning(false);
      return;
    }
    try {
      const response = await fetch('/api/roster/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const body = (await response.json()) as Report;
      setReport(body);
      if (body.ok) {
        onImported();
        void refreshStatus();
      }
    } catch (error) {
      setReport({ ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
    }
  };

  if (availability === 'checking' || availability === 'unavailable') return <></>;

  const last = showcases.find((showcase) => showcase.link === source)?.lastImport ?? showcases[0]?.lastImport;
  const edited = (report?.showcase ?? []).filter((key) => builds[key]);

  return (
    <section className="panel panel--full enka">
      <h3>{te.title}</h3>
      {
        <>
          <form
            className="enka__form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              type="text"
              placeholder={te.placeholder}
              value={source}
              onChange={(event) => setSource(event.target.value)}
              aria-label={te.linkLabel}
              disabled={running}
            />
            <button type="submit" className="chip chip--on" disabled={running || source.trim() === ''}>
              {running ? te.importing : te.update}
            </button>
          </form>
          <p className="hint">
            {te.hint}
            {last && te.lastImport(new Date(last).toLocaleString(t.locale))}
          </p>
          {availability === 'proxy' && (
            <p className="hint">
              {te.viaProxy}{' '}
              {showcases.length > 0 && (
                <button
                  type="button"
                  className="linkish"
                  onClick={() => {
                    void forgetShowcase().then(() => {
                      setReport(null);
                      setShowcases([]);
                      setSource('');
                      onImported();
                    });
                  }}
                >
                  {te.forget}
                </button>
              )}
            </p>
          )}
        </>
      }

      {report && !report.ok && <p className="hint hint--warn">{te.failed(failure(report))}</p>}

      {report?.ok && (
        <div className="enka__report">
          <p>
            {report.nickname ? <b>{report.nickname}</b> : <>UID {report.uid}</>}: {te.onShowcase}{' '}
            {(report.showcase ?? []).map(name).join(', ') || te.nobody}.
          </p>
          <ul className="warnings">
            <li>{te.newOnes}: {(report.new ?? []).map(name).join(', ') || '—'}</li>
            <li>{te.changed}: {(report.changed ?? []).map(name).join(', ') || '—'}</li>
            <li>{te.unchanged}: {(report.unchanged ?? []).length}</li>
            {(report.kept ?? []).length > 0 && (
              <li>{te.kept}: {(report.kept ?? []).length}</li>
            )}
          </ul>
          {(report.unresolved ?? []).length > 0 && (
            <p className="hint hint--warn">
              {te.unresolved} {(report.unresolved ?? []).join('; ')}.
            </p>
          )}
          {(report.unknown ?? []).length > 0 && (
            <p className="hint hint--warn">
              {te.unknown} {(report.unknown ?? []).map(String).join(', ')}.
            </p>
          )}
          {edited.length > 0 && (
            <div className="hint hint--warn">
              {te.variantActive}{' '}
              {edited.map((key, index) => (
                <span key={key}>
                  {index > 0 && ', '}
                  {name(key)}{' '}
                  <button type="button" className="chip" onClick={() => reset(key)}>
                    {te.showShowcase}
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
