/**
 * Roster screen: the operator list, click opens the build editor (E2).
 *
 * Owned operators come first and are highlighted: the roster is what the
 * user actually plays, while the rest are here for comparing team comps.
 */

import { useEffect, useMemo, useState } from 'react';

import type { Operator } from '@engine/index.js';

import { About } from './About.js';
import { countView } from './analytics.js';
import { SiteFooter, SiteHeader, type Screen } from './Chrome.js';

import BuildEditor from './BuildEditor.js';
import { ELEMENT_COLOR } from './colors.js';
import Track from './Track.js';
import { iconUrl, listed, useBundle } from './data.js';
import { EnkaImport } from './EnkaImport.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { useLang, useT } from './i18n/index.js';
import { useNames, useRuNames } from './i18n/names.js';
import { rotFromHash } from './share.js';
import { useApp } from './store.js';

function OperatorCard({
  operator,
  owned,
  hasRoster,
  onOpen,
}: {
  operator: Operator;
  owned: boolean;
  /** Without a roster nobody is "not owned": there is nothing to own against. */
  hasRoster: boolean;
  onOpen: () => void;
}): JSX.Element {
  const t = useT();
  const n = useNames();
  const accent = ELEMENT_COLOR[operator.element] ?? '#888';
  const combat = operator.skills.find((skill) => skill.type === 'Battle Skill');

  return (
    <article
      className={owned ? 'card card--owned' : 'card'}
      style={{ '--accent': accent } as React.CSSProperties}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') onOpen();
      }}
    >
      <div className="card__portrait">
        {operator.icon ? (
          <img src={iconUrl(operator.icon)} alt="" loading="lazy" width={72} height={72} />
        ) : (
          <div className="card__noicon" aria-hidden="true" />
        )}
        <span className="card__rarity">{'★'.repeat(operator.rarity)}</span>
      </div>

      <div className="card__body">
        <h3 className="card__name">
          {n.operator(operator.key, operator.name)}
          {operator.upcoming && <span className="tag tag--soft">{t.roster.unreleased}</span>}
          {hasRoster && !owned && !operator.upcoming && <span className="tag">{t.roster.notOwned}</span>}
        </h3>

        <div className="card__meta">
          {operator.elementIcon && (
            <img src={iconUrl(operator.elementIcon)} alt="" width={16} height={16} />
          )}
          <span style={{ color: accent }}>{n.term(operator.element)}</span>
          <span className="dot">·</span>
          {operator.classIcon && (
            <img src={iconUrl(operator.classIcon)} alt="" width={16} height={16} />
          )}
          <span>{n.term(operator.class)}</span>
        </div>

        <div className="card__attrs">
          <span>
            {t.common.main} <b>{operator.mainAttribute ?? '—'}</b>
          </span>
          <span>
            {t.common.sub} <b>{operator.subAttribute ?? '—'}</b>
          </span>
        </div>

        {combat && (
          <div className="card__skill">
            {combat.icon && <img src={iconUrl(combat.icon)} alt="" width={20} height={20} />}
            <span>{n.skill(combat.name)}</span>
          </div>
        )}

        <div className="card__tags">
          {operator.tags.map((tag) => (
            <span className="tag" key={tag}>
              {n.term(tag)}
            </span>
          ))}
        </div>
      </div>
    </article>
  );
}

export default function App(): JSX.Element {
  const state = useBundle();
  const t = useT();
  const n = useNames();
  const lang = useLang((store) => store.lang);
  const [element, setElement] = useState<string>('all');
  const [query, setQuery] = useState('');
  // «Only mine» starts on when there is a roster, and does not exist without one.
  const [onlyMine, setOnlyMine] = useState<boolean | null>(null);

  const loadRuNames = useRuNames((store) => store.load);
  useEffect(() => {
    document.documentElement.lang = lang;
    if (lang === 'ru') loadRuNames();
  }, [lang, loadRuNames]);
  // The screen lives in the address, so a reload keeps you on the track and
  // the browser's back button works between sections.
  const [screen, setScreenState] = useState<Screen>(() => screenFromHash(window.location.hash));
  const select = useApp((store) => store.select);
  useEffect(() => {
    // The event's own address, not `location`: the track may already have
    // taken the rotation out of the fragment (`Track.tsx`).
    const follow = (event: HashChangeEvent): void => {
      const hash = new URL(event.newURL).hash;
      setScreenState(screenFromHash(hash));
      // A shared rotation link opened in this tab: the build editor, if one
      // is open, would otherwise stay on top of the track that gets it.
      if (rotFromHash(hash)) select(null);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [select]);
  const setScreen = (next: Screen): void => {
    window.location.hash = next === 'roster' ? '' : next;
    setScreenState(next);
  };
  const selected = useApp((store) => store.selected);
  // Counted by name, never by the address: see analytics.ts.
  useEffect(() => {
    if (selected) countView(`/operator/${selected}`);
    else countView(screen === 'roster' ? '/' : `/${screen}`);
  }, [screen, selected]);
  const hydrate = useApp((store) => store.hydrate);
  const variants = useApp((store) => store.variants);
  const exportJson = useApp((store) => store.exportJson);
  const importJson = useApp((store) => store.importJson);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  const bundle = state.status === 'ready' ? state.bundle : null;
  const rosterKeys = useMemo(
    () => new Set(Object.keys(bundle?.roster?.operators ?? {})),
    [bundle],
  );
  const hasRoster = rosterKeys.size > 0;
  const mineOnly = hasRoster && (onlyMine ?? true);

  const operators = useMemo(() => {
    if (!bundle) return [];
    const needle = query.trim().toLowerCase();
    return Object.values(bundle.operators)
      .filter((operator) => !mineOnly || rosterKeys.has(operator.key))
      .filter((operator) => listed(operator.key, rosterKeys))
      .filter((operator) => element === 'all' || operator.element === element)
      .filter(
        (operator) =>
          needle === '' ||
          operator.name.toLowerCase().includes(needle) ||
          n.operator(operator.key, operator.name).toLowerCase().includes(needle),
      )
      .sort(
        (a, b) =>
          Number(rosterKeys.has(b.key)) - Number(rosterKeys.has(a.key)) ||
          b.rarity - a.rarity ||
          n.operator(a.key, a.name).localeCompare(n.operator(b.key, b.name), t.locale),
      );
  }, [bundle, element, query, mineOnly, rosterKeys, t.locale, n]);

  const elements = useMemo(() => {
    if (!bundle) return [];
    return [...new Set(Object.values(bundle.operators).map((o) => o.element))].sort();
  }, [bundle]);

  if (state.status === 'loading') {
    return <main className="shell">{t.common.loading}</main>;
  }

  if (state.status === 'error') {
    return (
      <main className="shell">
        <h1>{t.loadError.title}</h1>
        <p>{t.loadError.hint}</p>
        <pre className="error">{state.message}</pre>
      </main>
    );
  }

  const { bundle: data } = state;

  const navigate = (next: Screen): void => {
    select(null);
    setScreen(next);
    window.scrollTo(0, 0);
  };
  /** Every screen in the same frame: the header with the sections, the footer with the attribution. */
  const frame = (content: JSX.Element, wide = false): JSX.Element => (
    <main className={wide ? 'shell shell--wide' : 'shell'}>
      <SiteHeader screen={selected ? 'roster' : screen} onNavigate={navigate} />
      {/* The header stays, so a screen that broke can be left. */}
      <ErrorBoundary resetKey={`${screen}:${selected ?? ''}`}>{content}</ErrorBoundary>
      <SiteFooter bundle={data} onAbout={() => navigate('about')} />
    </main>
  );

  if (selected) {
    return frame(<BuildEditor bundle={data} operatorKey={selected} onBack={() => select(null)} />);
  }

  if (screen === 'track') {
    return frame(<Track bundle={data} onBack={() => setScreen('roster')} />, true);
  }

  if (screen === 'about') {
    return frame(<About bundle={data} />);
  }

  return frame(
    <>
      <p className="lead">{t.roster.tagline}</p>

      <div className="controls">
        <input
          type="search"
          placeholder={t.roster.search}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label={t.roster.searchLabel}
        />
        <div className="chips">
          {['all', ...elements].map((name) => (
            <button
              key={name}
              type="button"
              className={name === element ? 'chip chip--on' : 'chip'}
              onClick={() => setElement(name)}
              style={
                name !== 'all'
                  ? ({ '--accent': ELEMENT_COLOR[name] ?? '#888' } as React.CSSProperties)
                  : undefined
              }
            >
              {name === 'all' ? t.common.all : n.term(name)}
            </button>
          ))}
        </div>
        {hasRoster && (
          <button type="button" className={mineOnly ? 'chip chip--on' : 'chip'} onClick={() => setOnlyMine(!mineOnly)}>
            {t.common.onlyMine}
          </button>
        )}
        <span className="count">{operators.length}</span>
      </div>

      <div className="controls controls--small">
        <span className="muted">
          {t.roster.savedVariants}{' '}
          <b>{Object.values(variants).reduce((sum, entry) => sum + entry.variants.length, 0)}</b>
        </span>
        <button
          type="button"
          className="chip"
          onClick={() => {
            // Download: edits live only in this browser, so exporting is
            // the only way to move them anywhere else.
            const blob = new Blob([exportJson()], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = t.roster.exportName(new Date().toISOString().slice(0, 10));
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          {t.roster.exportBuilds}
        </button>
        <label className="chip">
          {t.roster.importBuilds}
          <input
            type="file"
            accept="application/json"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              try {
                const count = importJson(await file.text());
                setNotice(t.roster.imported(count));
              } catch (error) {
                setNotice(t.roster.importFailed(error instanceof Error ? error.message : String(error)));
              }
              event.target.value = '';
            }}
          />
        </label>
        {notice && <span className="muted">{notice}</span>}
      </div>

      <EnkaImport bundle={data} onImported={state.reload} />

      <section className="grid">
        {operators.map((operator) => (
          <OperatorCard
            key={operator.key}
            operator={operator}
            owned={rosterKeys.has(operator.key)}
            hasRoster={hasRoster}
            onOpen={() => select(operator.key)}
          />
        ))}
      </section>

      {operators.length === 0 && <p className="empty">{t.roster.nothing}</p>}

      <p className="counts">
        {t.footer.counts({
          operators: data.counts.operators ?? 0,
          weapons: data.counts.weapons ?? 0,
          gear: data.counts.gearPieces ?? 0,
          sets: data.counts.gearSets ?? 0,
          enemies: data.counts.enemies ?? 0,
          mechanics: data.counts.mechanics ?? 0,
        })}
        {hasRoster && <> · {t.footer.roster(rosterKeys.size)}</>}
      </p>
    </>,
  );
}

function screenFromHash(hash: string): Screen {
  if (hash.startsWith('#track')) return 'track';
  if (hash.startsWith('#about')) return 'about';
  return 'roster';
}
