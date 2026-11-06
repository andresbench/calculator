/**
 * Refresh the roster from an Enka.Network showcase.
 *
 * The work happens on the local dev server (`app/enka.ts`), which runs
 * `tools/ef/profile.py` and `tools/ef/export.py`; this panel only sends the
 * link and shows the report. On a static build the endpoint is missing and
 * the panel says how to get it.
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
import { useApp } from './store.js';

interface Showcase {
  uid: string;
  link: string;
  lastImport: string | null;
}

interface Report {
  ok: boolean;
  /** Set by `profile.py --json` on failure; its `error` text is Russian CLI output. */
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
  log?: string;
}

type Availability = 'checking' | 'available' | 'unavailable';

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
      setAvailability('available');
      setShowcases(body.showcases ?? []);
      setSource((current) => current || body.showcases?.[0]?.link || '');
    } catch {
      setAvailability('unavailable');
    }
  };

  useEffect(() => {
    void refreshStatus();
  }, []);

  const name = (key: string): string => bundle.operators[key]?.name ?? key;

  const submit = async (): Promise<void> => {
    setRunning(true);
    setReport(null);
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

  // A static build has no import endpoint: the panel is for the local app only.
  if (availability !== 'available') return <></>;

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
