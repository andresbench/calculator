/**
 * Rotation screen: browse the repository files, or build one from scratch.
 *
 * The editing model is the point worth stating. **A draft holds an order,
 * not a timeline.** Where a step lands in seconds is derived by the engine
 * from cooldowns, SP regeneration and action durations; letting someone drag
 * a block to 3.5 s would invite them to assert a time the simulation is
 * about to overrule. So the sequence is what gets edited, and the track
 * above it is the result, redrawn on every change.
 *
 * Files in `rotations/` are never written by the app. They are played with,
 * and they are the engine's acceptance test — "duplicate" copies one into a
 * browser-side draft, and the way back is text the user saves themselves.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  actionsFor,
  addStep,
  buildAliases,
  checkRoundTrip,
  draftFromRotation,
  draftsFromText,
  draftSteps,
  draftToText,
  dummyTarget,
  parseRot,
  ENEMY_CLASSES,
  moveStep,
  normaliseStages,
  patchStep,
  removeStep,
  setComboPriority,
  setTeam,
  spAt,
  TEAM_SIZE,
  priorityOrder,
  type ActionKind,
  type Bundle,
  type Draft,
  type Message,
} from '@engine/index.js';

/** What a palette button adds: a skill action, a dodge or a pause. */
interface PaletteEntry {
  kind: ActionKind;
  sequence: number | null;
  seconds?: number;
}

/** A new pause lasts this long; the step editor changes it. */
const DEFAULT_PAUSE = 1;

/** Target picker values for the dummy: `dummy:` alone has no meter, `dummy:Boss` a typical boss's. */
const DUMMY_PREFIX = 'dummy:';

import { iconUrl, listed } from './data.js';
import { RosterStrip } from './RosterStrip.js';
import { compact, trackDamage, type TrackDamage } from './trackDamage.js';
import { useApp } from './store.js';
import { ELEMENT_COLOR } from './colors.js';
import { useLang, useT } from './i18n/index.js';
import { opName, useNames } from './i18n/names.js';
import { say } from './messages.js';
import { decodeRot, rotFromHash, shareUrl } from './share.js';
import { buildTrack, viewFromSteps, type TrackSetup, type TrackView } from './track.js';
import {
  SpBar,
  TrackCanvas,
  DamagePanel,
  TrackPanels,
  type OperatorDrag,
} from './TrackCanvas.js';

/** Operators the palette offers first: the ones actually in the account. */
function rosterFirst(bundle: Bundle): string[] {
  const owned = Object.keys(bundle.roster?.operators ?? {});
  const rest = Object.values(bundle.operators)
    .filter((operator) => !owned.includes(operator.key) && !operator.upcoming && listed(operator.key))
    .map((operator) => operator.key);
  return [...owned.sort(), ...rest.sort()];
}

/**
 * The action palette for one team member.
 *
 * Options come from `actionsFor`, which reads them out of the skill data —
 * three battle-skill stages for Mi Fu, one for Chen. Offering a stage that
 * does not exist would produce a rotation nobody can play while the track
 * showed it as fine.
 */
function Palette({
  bundle,
  actor,
  onAdd,
}: {
  bundle: Bundle;
  actor: string;
  onAdd: (entry: PaletteEntry) => void;
}): JSX.Element | null {
  const operator = bundle.operators[actor];
  const options = useMemo(() => (operator ? actionsFor(operator) : []), [operator]);
  const t = useT().track;
  useNames();
  if (!operator) return null;

  return (
    <div className="palette">
      <div className="palette__who">
        {operator.icon && <img src={iconUrl(operator.icon)} alt="" width={20} height={20} />}
        <span style={{ color: ELEMENT_COLOR[operator.element] ?? '#888' }}>{opName(bundle, operator.key)}</span>
      </div>
      <div className="palette__keys">
        {options.map((option) => (
          <button
            key={option.token}
            type="button"
            className="chip"
            title={option.name}
            onClick={() => onAdd(option)}
          >
            {option.token}
          </button>
        ))}
        {/* Not skills: they take time, which is what a rotation sometimes needs. */}
        <button type="button" className="chip chip--filler" title={t.dodgeTitle} onClick={() => onAdd({ kind: 'DODGE', sequence: null })}>
          {t.dodge}
        </button>
        <button
          type="button"
          className="chip chip--filler"
          title={t.pauseTitle}
          onClick={() => onAdd({ kind: 'WAIT', sequence: null, seconds: DEFAULT_PAUSE })}
        >
          {t.pause}
        </button>
      </div>
    </div>
  );
}

/**
 * The step list: the thing actually being edited.
 *
 * Rows are reordered by dragging. Native drag and drop rather than a
 * library: the list is one column of short rows, and a dependency for that
 * would cost more than it explains.
 */
function StepList({
  bundle,
  draft,
  view,
  damage,
  selected,
  onSelect,
  onChange,
}: {
  bundle: Bundle;
  draft: Draft;
  view: TrackView;
  damage: TrackDamage | null;
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (draft: Draft) => void;
}): JSX.Element {
  const [dragging, setDragging] = useState<string | null>(null);
  const tt = useT();
  const t = tt.track;
  useNames();

  const problemsByStep = new Map<number, string[]>();
  for (const problem of view.problems) {
    const list = problemsByStep.get(problem.step);
    const text = say(bundle, problem.message);
    if (list) list.push(text);
    else problemsByStep.set(problem.step, [text]);
  }

  if (draft.steps.length === 0) {
    return (
      <p className="hint">{t.stepsEmpty}</p>
    );
  }

  return (
    <ol className="steps">
      {draft.steps.map((step, index) => {
        const operator = bundle.operators[step.actor];
        const problems = problemsByStep.get(index + 1) ?? [];
        const previous = draft.steps[index - 1];
        return (
          <li key={step.id}>
            {previous && previous.cycle !== step.cycle && (
              <div className="steps__cycle">{t.cycle(step.cycle)}</div>
            )}
            <div
              className={`step${selected === step.id ? ' step--on' : ''}${
                problems.length > 0 ? ' step--bad' : ''
              }`}
              draggable
              onDragStart={() => setDragging(step.id)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragging && dragging !== step.id) onChange(moveStep(draft, dragging, index));
                setDragging(null);
              }}
              onClick={() => onSelect(selected === step.id ? null : step.id)}
            >
              <span className="step__no">{index + 1}</span>
              {operator?.icon && <img src={iconUrl(operator.icon)} alt="" width={18} height={18} />}
              <span className="step__actor">{opName(bundle, step.actor)}</span>
              <span className="step__kind">
                {step.kind === 'WAIT' ? `${t.pause} ${step.seconds ?? 0}s` : step.kind === 'DODGE' ? t.dodge : step.kind}
                {step.sequence ?? ''}
                {step.optional && '~'}
                {step.uncertain && '?'}
              </span>
              {step.note && <span className="step__note">{step.note}</span>}
              {(damage?.steps[index]?.total ?? 0) > 0 && (
                <span className="step__dmg">{compact(damage!.steps[index]!.total)}</span>
              )}
              {problems.length > 0 && <span className="step__warn" title={problems.join('; ')}>!</span>}
              <span className="step__grip" aria-hidden="true">
                ⠿
              </span>
            </div>

            {selected === step.id && (
              <div className="step__edit">
                {step.kind === 'WAIT' && (
                  <label className="check">
                    {t.pauseSeconds}
                    <input
                      type="number"
                      min={0}
                      step={0.1}
                      className="step__seconds"
                      value={step.seconds ?? 0}
                      onChange={(event) =>
                        onChange(patchStep(draft, step.id, { seconds: Math.max(0, Number(event.target.value) || 0) }))
                      }
                    />
                  </label>
                )}
                <label className="check">
                  <input
                    type="checkbox"
                    checked={step.optional}
                    onChange={(event) => onChange(patchStep(draft, step.id, { optional: event.target.checked }))}
                  />
                  {t.optional}
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={step.uncertain}
                    onChange={(event) => onChange(patchStep(draft, step.id, { uncertain: event.target.checked }))}
                  />
                  {t.uncertain}
                </label>
                <input
                  type="text"
                  className="step__noteinput"
                  placeholder={t.notePlaceholder}
                  value={step.note ?? ''}
                  onChange={(event) =>
                    onChange(patchStep(draft, step.id, { note: event.target.value || null }))
                  }
                />
                <button type="button" className="chip" onClick={() => onChange(moveStep(draft, step.id, index - 1))}>
                  ↑
                </button>
                <button type="button" className="chip" onClick={() => onChange(moveStep(draft, step.id, index + 1))}>
                  ↓
                </button>
                <button
                  type="button"
                  className="chip"
                  onClick={() => {
                    onChange(removeStep(draft, step.id));
                    onSelect(null);
                  }}
                >
                  {tt.common.delete}
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Combo Skill Priority, as the game's settings screen has it.
 *
 * When several combos trigger at the same moment, the game casts them in
 * this order; by default it is the team order. The engine checks the steps
 * against it, so a rotation written in an order the game will not play gets
 * flagged. Reordered by dragging, like in the game.
 */
function ComboPriority({
  bundle,
  team,
  priority,
  onChange,
}: {
  bundle: Bundle;
  team: string[];
  /** Custom order; empty means team order. */
  priority: string[];
  /** Absent: read only, for rotation files. */
  onChange?: (priority: string[]) => void;
}): JSX.Element {
  const [dragging, setDragging] = useState<number | null>(null);
  const t = useT().track;
  useNames();
  const order = priorityOrder(team, priority);
  const custom = priority.length > 0;

  return (
    <div className="priority">
      <div className="priority__row">
        {order.map((key, index) => {
          const operator = bundle.operators[key];
          return (
            <div
              key={key}
              className={`priority__item${dragging === index ? ' priority__item--drag' : ''}`}
              draggable={Boolean(onChange)}
              onDragStart={() => setDragging(index)}
              onDragEnd={() => setDragging(null)}
              onDragOver={(event) => {
                if (dragging != null) event.preventDefault();
              }}
              onDrop={() => {
                if (dragging == null || !onChange) return;
                const next = [...order];
                const [moved] = next.splice(dragging, 1);
                next.splice(index, 0, moved!);
                onChange(next);
                setDragging(null);
              }}
              title={opName(bundle, key)}
            >
              {operator?.icon ? (
                <img src={iconUrl(operator.icon)} alt="" width={36} height={36} draggable={false} />
              ) : (
                <span>{opName(bundle, key)}</span>
              )}
              <span className="priority__no">{index + 1}</span>
            </div>
          );
        })}
      </div>
      <p className="hint">
        {custom ? t.priorityCustom : t.priorityDefault} {t.priorityHint}
        {onChange && custom && (
          <>
            {' '}
            <button type="button" className="linkish" onClick={() => onChange([])}>
              {t.priorityReset}
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** A file name from a rotation title: what a file system will take, nothing else. */
function rotFileName(title: string): string {
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, '-').slice(0, 80);
  return `${base || 'rotation'}.rot`;
}

/**
 * The way out: into the repository, a file, or someone else's browser.
 *
 * The text is re-parsed before it is offered, and the result compared with
 * the draft. An export that silently drops a step is worse than none: it
 * would be found out a week later, in a file already committed.
 */
function ExportPanel({ bundle, draft }: { bundle: Bundle; draft: Draft }): JSX.Element {
  const t = useT();
  const text = draftToText(bundle, draft);
  const check = checkRoundTrip(bundle, draft, text);
  const [notice, setNotice] = useState<string | null>(null);

  const download = (): void => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = rotFileName(draft.title);
    link.click();
    URL.revokeObjectURL(url);
  };

  const copyLink = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(await shareUrl(text));
      setNotice(t.track.linkCopied);
    } catch (error) {
      setNotice(t.track.linkFailed(error instanceof Error ? error.message : String(error)));
    }
  };

  return (
    <section className="panel panel--full">
      <h3>{t.track.export}</h3>
      <p className="hint">{t.track.exportHint}</p>
      <textarea className="export" readOnly value={text} rows={Math.min(20, draft.steps.length + 5)} />
      <div className="chips">
        <button type="button" className="chip" onClick={() => void navigator.clipboard?.writeText(text)}>
          {t.common.copy}
        </button>
        <button type="button" className="chip" onClick={download}>
          {t.track.download}
        </button>
        <button type="button" className="chip" onClick={() => void copyLink()} disabled={!check.ok}>
          {t.track.copyLink}
        </button>
        <span className={check.ok ? 'hint' : 'hint hint--warn'}>
          {notice ??
            (check.ok
              ? t.track.roundTripOk
              : t.track.roundTripLost(check.problems.map((problem) => say(bundle, problem)).join('; ')))}
        </span>
      </div>
    </section>
  );
}

/** What an import said: how many drafts it made, and what it could not read. */
interface ImportReport {
  count: number;
  problems: Message[];
}

function ImportReportLine({ bundle, report }: { bundle: Bundle; report: ImportReport }): JSX.Element {
  const t = useT().track;
  const problems = report.problems.map((problem) => say(bundle, problem)).join('; ');
  if (report.count === 0) return <p className="hint hint--warn">{t.importFailed(problems)}</p>;
  return (
    <p className={problems ? 'hint hint--warn' : 'hint'}>
      {t.imported(report.count)}
      {problems && ` ${t.importWarnings(problems)}`}
    </p>
  );
}

/**
 * The way in: `.rot` text pasted, or a file. Drafts live in this browser, so
 * without this a rotation could leave the app but never arrive in anyone
 * else's.
 */
function ImportPanel({
  bundle,
  onImport,
}: {
  bundle: Bundle;
  onImport: (text: string, fallbackTitle: string) => ImportReport;
}): JSX.Element {
  const t = useT().track;
  const [text, setText] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);

  return (
    <section className="panel panel--full">
      <h3>{t.import}</h3>
      <p className="hint">{t.importHint}</p>
      <textarea
        className="export"
        value={text}
        rows={6}
        placeholder={t.importPlaceholder}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="chips">
        <button
          type="button"
          className="chip"
          disabled={!text.trim()}
          onClick={() => {
            const result = onImport(text, t.importedTitle);
            setReport(result);
            if (result.count > 0) setText('');
          }}
        >
          {t.importButton}
        </button>
        <label className="chip">
          {t.importFile}
          <input
            type="file"
            accept=".rot,.txt,text/plain"
            hidden
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              setReport(onImport(await file.text(), file.name.replace(/\.[^.]*$/, '')));
            }}
          />
        </label>
      </div>
      {report && <ImportReportLine bundle={bundle} report={report} />}
    </section>
  );
}

export default function Track({ bundle, onBack }: { bundle: Bundle; onBack: () => void }): JSX.Element {
  const drafts = useApp((state) => state.drafts);
  const builds = useApp((state) => state.builds);
  const buildFor = useApp((state) => state.buildFor);
  const newDraft = useApp((state) => state.newDraft);
  const loaded = useApp((state) => state.loaded);
  const saveDraft = useApp((state) => state.saveDraft);
  const deleteDraft = useApp((state) => state.deleteDraft);
  const tt = useT();
  const t = tt.track;
  const lang = useLang((state) => state.lang);
  const n = useNames();

  const rotationKeys = Object.keys(bundle.rotations ?? {});
  // A file's name is its `title:`, read by the engine's parser; the file name is the fallback.
  const rotationTitles = useMemo(() => {
    const aliases = buildAliases(bundle);
    return Object.fromEntries(
      Object.entries(bundle.rotations ?? {}).map(([key, file]) => [key, parseRot(file.text, aliases).title ?? file.name]),
    );
  }, [bundle]);
  // Classes whose enemies have a stagger meter in the data, with the meter the dummy would take.
  const dummyMeters = useMemo(
    () =>
      ENEMY_CLASSES.flatMap((enemyClass) => {
        const meter = dummyTarget(bundle, enemyClass).staggerMeter;
        return meter == null ? [] : [{ enemyClass, meter }];
      }),
    [bundle],
  );
  const [source, setSource] = useState<string>(rotationKeys[0] ? `file:${rotationKeys[0]}` : '');
  const [variantIndex, setVariantIndex] = useState(0);
  const [enemyKey, setEnemyKey] = useState<string | null>(null);
  /** With no enemy: the dummy takes a typical stagger meter of this class, or none. */
  const [dummyClass, setDummyClass] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  /**
   * The cycle the next added action will fall into.
   *
   * A cycle is the rotation's own bookkeeping: a second cycle exists exactly
   * because the first one's debuffs are still up. So it is not a separate
   * structure but a number on the step, and "+ cycle" just says what number
   * the next one gets.
   */
  const [pendingCycle, setPendingCycle] = useState<number | null>(null);

  /** What opening a shared link did; shown until the next import or dismissal. */
  const [linkReport, setLinkReport] = useState<ImportReport | null>(null);

  const draft = source.startsWith('draft:') ? drafts[source.slice(6)] ?? null : null;
  const file = source.startsWith('file:') ? source.slice(5) : null;

  // Older drafts carry stage numbers that turned out to be hits of one press.
  useEffect(() => {
    if (!draft) return;
    const fixed = normaliseStages(bundle, draft);
    if (fixed !== draft) saveDraft(fixed);
  }, [bundle, draft, saveDraft]);

  // The track simulates with the builds the user sees in the build editor,
  // not with a second copy of the roster: hover a portrait, and what it says
  // is what the track ran.
  const trackBuilds = useMemo<TrackSetup['builds']>(
    () =>
      Object.fromEntries(
        Object.entries(builds).map(([key, build]) => [
          key,
          { level: build.level, elite: build.elite, potential: build.potential, skills: build.skills },
        ]),
      ),
    [builds],
  );

  const fileTrack = useMemo(() => {
    const text = file ? bundle.rotations?.[file]?.text ?? '' : '';
    return text ? buildTrack(bundle, text, enemyKey, trackBuilds, dummyClass, (key) => buildFor(key, bundle)) : null;
    // `builds` is what `buildFor` reads: gear decides the Stagger a member deals.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, file, enemyKey, trackBuilds, dummyClass, builds]);

  const draftView = useMemo(
    () =>
      draft
        ? viewFromSteps(bundle, draftSteps(draft), enemyKey, draft.variant, {
            order: draft.team,
            priority: draft.comboPriority ?? [],
            ultimatesCharged: draft.ultimatesCharged ?? false,
            unlimitedSp: draft.unlimitedSp ?? false,
            controlled: draft.controlled ?? null,
            dummyClass,
            builds: trackBuilds,
            buildOf: (key) => buildFor(key, bundle),
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle, draft, enemyKey, trackBuilds, dummyClass, builds],
  );

  const view: TrackView | null =
    draftView ?? fileTrack?.views[variantIndex] ?? fileTrack?.views[0] ?? null;

  const damage = useMemo(
    () => (view ? trackDamage(bundle, view, (key) => buildFor(key, bundle), enemyKey) : null),
    // `builds` is what `buildFor` reads: a build edit has to redo the damage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bundle, view, enemyKey, builds, lang, n],
  );

  const selectedIndex = draft && selected ? draft.steps.findIndex((step) => step.id === selected) : -1;

  const change = (next: Draft): void => saveDraft(next);

  const addFromPalette = (actor: string, option: PaletteEntry): void => {
    if (!draft) return;
    const at = selectedIndex >= 0 ? selectedIndex + 1 : draft.steps.length;
    const cycle = pendingCycle ?? draft.steps[Math.max(0, at - 1)]?.cycle ?? 1;
    setPendingCycle(null);
    const next = addStep(
      draft,
      {
        actor,
        kind: option.kind,
        sequence: option.sequence,
        ...(option.seconds != null ? { seconds: option.seconds } : {}),
        optional: false,
        uncertain: false,
        note: null,
        cycle,
      },
      at,
    );
    saveDraft(next);
    setSelected(next.steps[at]?.id ?? null);
  };

  const duplicate = (): void => {
    if (!fileTrack || !file) return;
    const variant = fileTrack.views[variantIndex]?.variant ?? null;
    const copy = draftFromRotation(fileTrack.rotation, variant, rotationTitles[file]!);
    saveDraft(copy);
    setSource(`draft:${copy.id}`);
    setSelected(null);
    setCursor(0);
  };

  /** Text → drafts in this browser; the first one opens. */
  const importText = (text: string, fallbackTitle: string): ImportReport => {
    const { drafts: made, problems } = draftsFromText(bundle, text, fallbackTitle);
    for (const made1 of made) saveDraft(made1);
    if (made[0]) {
      setSource(`draft:${made[0].id}`);
      setSelected(null);
      setCursor(0);
    }
    return { count: made.length, problems };
  };

  // A shared link: `#track?rot=…`. Waits for the stored drafts, or saving
  // the imported one would write over them; then the fragment goes back to
  // plain `#track`, so a reload does not import it twice.
  useEffect(() => {
    if (!loaded) return;
    const data = rotFromHash(window.location.hash);
    if (!data) return;
    window.history.replaceState(null, '', '#track');
    decodeRot(data)
      .then((text) => setLinkReport(importText(text, t.importedTitle)))
      .catch(() => setLinkReport({ count: 0, problems: [{ code: 'importBadLink' }] }));
    // Runs once the drafts are in; `importText` is a fresh closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const blank = (): void => {
    const created = newDraft();
    setSource(`draft:${created.id}`);
    setSelected(null);
    setCursor(0);
  };

  /**
   * The draft a team change lands in. A rotation file is read only, so
   * dropping someone onto its track first makes the same copy that
   * «duplicate as draft» would.
   */
  const editable = (): Draft => {
    if (draft) return draft;
    if (fileTrack && file) {
      const variant = fileTrack.views[variantIndex]?.variant ?? null;
      return draftFromRotation(fileTrack.rotation, variant, rotationTitles[file]!);
    }
    return newDraft();
  };

  const commitTeam = (base: Draft, next: Draft): void => {
    saveDraft(next);
    if (base !== draft) {
      setSource(`draft:${next.id}`);
      setSelected(null);
    }
  };

  /**
   * An operator dropped on a slot.
   *
   * Slots are fixed, as in the game: the operator lands exactly where it was
   * dropped, and nobody slides over to fill a gap. From inside the team the
   * two swap places, an empty slot included. From the roster an empty slot
   * just takes it; an occupied one is replaced, together with that
   * operator's steps, after asking.
   */
  const place = (drag: OperatorDrag, slot: number): void => {
    const base = editable();
    const team = Array.from({ length: TEAM_SIZE }, (_, i) => base.team[i] ?? '');
    const at = Math.max(0, Math.min(slot - 1, TEAM_SIZE - 1));
    const from = team.indexOf(drag.operator);

    if (from >= 0) {
      [team[from], team[at]] = [team[at]!, team[from]!];
    } else {
      const replaced = team[at]!;
      if (replaced) {
        const steps = base.steps.filter((step) => step.actor === replaced).length;
        if (steps > 0 && !window.confirm(t.replace(opName(bundle, replaced), steps))) return;
      }
      team[at] = drag.operator;
    }
    commitTeam(base, setTeam(base, team));
  };

  /** Who starts controlled; `null` hands the pick back to the track. A file becomes a draft, as with a slot drop. */
  const startControlled = (key: string | null): void => {
    const base = editable();
    const { controlled: _dropped, ...rest } = base;
    commitTeam(base, key ? { ...rest, controlled: key } : rest);
  };

  /** A ghost clicked: insert that CS where the engine says it opens, or the FS that finishes a BA. */
  const addGhost = (key: string, after: number, kind: 'CS' | 'FS'): void => {
    const base = editable();
    const cycle = base.steps[Math.max(0, after - 1)]?.cycle ?? 1;
    const next = addStep(
      base,
      { actor: key, kind, sequence: null, optional: false, uncertain: false, note: null, cycle },
      after,
    );
    commitTeam(base, next);
    setSelected(next.steps[after]?.id ?? null);
  };

  const pick = (key: string): void => {
    const team = draft?.team ?? fileTrack?.rotation.team ?? [];
    if (team.includes(key) || team.length >= TEAM_SIZE) return;
    place({ operator: key, fromSlot: null }, team.length + 1);
  };

  const team = draft?.team ?? fileTrack?.rotation.team ?? [];

  return (
    <div className="track">
      <div className="trackhead">
        <aside className="trackhead__side">
          <div className="trackhead__title">
            <button type="button" className="chip" onClick={onBack}>
              {tt.common.back}
            </button>
            <h1>{t.title}</h1>
          </div>

          {(rotationKeys.length > 0 || Object.keys(drafts).length > 0) && (
          <select
            value={source}
            aria-label={t.rotationLabel}
            onChange={(event) => {
              setSource(event.target.value);
              setVariantIndex(0);
              setCursor(0);
              setSelected(null);
            }}
          >
            {rotationKeys.length > 0 && (
              <optgroup label={t.files}>
                {rotationKeys.map((key) => (
                  <option key={key} value={`file:${key}`}>
                    {rotationTitles[key]}
                  </option>
                ))}
              </optgroup>
            )}
            {Object.values(drafts).length > 0 && (
              <optgroup label={t.drafts}>
                {Object.values(drafts)
                  .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
                  .map((item) => (
                    <option key={item.id} value={`draft:${item.id}`}>
                      {item.title}
                    </option>
                  ))}
              </optgroup>
            )}
          </select>
          )}

          {fileTrack && !draft && fileTrack.views.length > 1 && (
            <select
              value={variantIndex}
              aria-label={t.variantLabel}
              onChange={(event) => {
                setVariantIndex(Number(event.target.value));
                setCursor(0);
              }}
            >
              {fileTrack.views.map((item, index) => (
                <option key={index} value={index}>
                  {item.variant ?? t.noVariant}
                </option>
              ))}
            </select>
          )}

          <select
            value={enemyKey ?? `${DUMMY_PREFIX}${dummyClass ?? ''}`}
            aria-label={t.enemyLabel}
            onChange={(event) => {
              const value = event.target.value;
              const dummy = value.startsWith(DUMMY_PREFIX);
              setEnemyKey(dummy ? null : value);
              setDummyClass(dummy ? value.slice(DUMMY_PREFIX.length) || null : null);
            }}
          >
            <optgroup label={t.dummyGroup}>
              <option value={DUMMY_PREFIX}>{t.dummy}</option>
              {dummyMeters.map(({ enemyClass, meter }) => (
                <option key={enemyClass} value={`${DUMMY_PREFIX}${enemyClass}`}>
                  {t.dummyMeter(enemyClass, meter)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t.enemyGroup}>
              {Object.values(bundle.enemies)
                .sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name))
                .map((enemy) => (
                  <option key={enemy.key} value={enemy.key}>
                    [{enemy.class}] {n.enemy(enemy.key, enemy.name)}
                  </option>
                ))}
            </optgroup>
          </select>

          <div className="chips">
            <button type="button" className="chip" onClick={blank}>
              {t.newDraft}
            </button>
            {fileTrack && !draft && (
              <button type="button" className="chip" onClick={duplicate}>
                {t.duplicate}
              </button>
            )}
            {draft && (
              <button
                type="button"
                className="chip"
                onClick={() => {
                  deleteDraft(draft.id);
                  setSource(rotationKeys[0] ? `file:${rotationKeys[0]}` : '');
                }}
              >
                {t.deleteDraft}
              </button>
            )}
          </div>
          {linkReport && <ImportReportLine bundle={bundle} report={linkReport} />}

          <div className="trackhead__meta">
            <label className="zoom">
              {t.zoom}
              <input
                type="range"
                min={0.5}
                max={4}
                step={0.25}
                value={zoom}
                onChange={(event) => setZoom(Number(event.target.value))}
              />
            </label>
            {view && (
              <span className="count">
                {t.length(view.length, view.waited)}
                {damage && damage.total > 0 && (
                  <>
                    <br />
                    {t.damageLine(compact(damage.total), compact(damage.dps))}
                  </>
                )}
              </span>
            )}
          </div>
        </aside>

        <RosterStrip bundle={bundle} team={team} onPick={pick} />
      </div>

      {!view ? (
        <>
          <div className="panel">
            <p>{t.noRotations}</p>
          </div>
          {/* The site ships no example rotations: pasting one must not need a draft first. */}
          <ImportPanel bundle={bundle} onImport={importText} />
        </>
      ) : (
        <>
          <div className="track__main">
            <div className="track__lane">
              <TrackCanvas
                bundle={bundle}
                view={view}
                cursor={cursor}
                setCursor={setCursor}
                zoom={zoom}
                selected={selectedIndex >= 0 ? selectedIndex + 1 : null}
                onSelectStep={
                  draft ? (index) => setSelected(draft.steps[index - 1]?.id ?? null) : undefined
                }
                onPlace={place}
                onGhost={addGhost}
                onControl={startControlled}
                controlChosen={Boolean(draft ? draft.controlled : fileTrack?.rotation.controlled)}
                damage={damage}
              />

              <div className="track__spbar">
                <SpBar sp={spAt(view.spTimeline, cursor, view.spRegen)} />
              </div>
            </div>
            {damage && <DamagePanel view={view} damage={damage} cursor={cursor} />}
          </div>

          {draft && (
            <>
              <div className="editor__grid">
                <section className="panel">
                  <h3>{t.actions}</h3>
                  {draft.team.filter(Boolean).map((key) => (
                    <Palette
                      key={key}
                      bundle={bundle}
                      actor={key}
                      onAdd={(option) => addFromPalette(key, option)}
                    />
                  ))}
                  {draft.team.length > 0 && (
                    <>
                      <p className="hint">{t.stagesHint}</p>
                      <button
                        type="button"
                        className={pendingCycle == null ? 'chip' : 'chip chip--on'}
                        disabled={draft.steps.length === 0}
                        onClick={() => {
                          const last = draft.steps[draft.steps.length - 1];
                          setPendingCycle(
                            pendingCycle == null ? (last?.cycle ?? 1) + 1 : null,
                          );
                          // A new cycle starts at the end, not after the
                          // selected step: inserting a cycle in the middle
                          // means renumbering everything after it.
                          setSelected(null);
                        }}
                      >
                        {pendingCycle == null ? t.addCycle : t.nextCycle(pendingCycle)}
                      </button>
                    </>
                  )}
                </section>

                <section className="panel panel--wide">
                  <h3>{t.stepsTitle}</h3>
                  <StepList
                    bundle={bundle}
                    draft={draft}
                    view={view}
                    damage={damage}
                    selected={selected}
                    onSelect={setSelected}
                    onChange={change}
                  />
                </section>
              </div>

              <div className="editor__split">
              <section className="panel">
                <h3>{t.comboPriority}</h3>
                {draft.team.filter(Boolean).length > 1 ? (
                  <ComboPriority
                    bundle={bundle}
                    team={draft.team.filter(Boolean)}
                    priority={draft.comboPriority ?? []}
                    onChange={(priority) => change(setComboPriority(draft, priority))}
                  />
                ) : (
                  <p className="hint">{t.priorityNeedsTwo}</p>
                )}
              </section>

              <section className="panel">
                <h3>{t.rotation}</h3>
                <div className="fields">
                  <label>
                    {tt.common.title}
                    <input
                      type="text"
                      className="wide"
                      value={draft.title}
                      onChange={(event) => change({ ...draft, title: event.target.value })}
                    />
                  </label>
                  <label>
                    {tt.common.variant}
                    <input
                      type="text"
                      placeholder={t.noVariantPlaceholder}
                      value={draft.variant ?? ''}
                      onChange={(event) => change({ ...draft, variant: event.target.value || null })}
                    />
                  </label>
                </div>

                <h3>{t.team}</h3>
                <div className="chips">
                  {draft.team.map((key, index) =>
                    key ? (
                      <button
                        key={key}
                        type="button"
                        className="chip chip--on"
                        title={t.removeMember}
                        // The slot stays, empty: the others keep their positions.
                        onClick={() => change(setTeam(draft, draft.team.map((name) => (name === key ? '' : name))))}
                      >
                        {String(index + 1).padStart(2, '0')} · {opName(bundle, key)} ✕
                      </button>
                    ) : null,
                  )}
                  {draft.team.filter(Boolean).length < TEAM_SIZE && (
                    <select
                      value=""
                      onChange={(event) => {
                        const picked = event.target.value;
                        if (!picked) return;
                        const hole = draft.team.indexOf('');
                        const team = hole >= 0 ? draft.team.map((name, i) => (i === hole ? picked : name)) : [...draft.team, picked];
                        change(setTeam(draft, team));
                      }}
                    >
                      <option value="">{t.addOperator}</option>
                      {rosterFirst(bundle)
                        .filter((key) => !draft.team.includes(key))
                        .map((key) => (
                          <option key={key} value={key}>
                            {opName(bundle, key)}
                          </option>
                        ))}
                    </select>
                  )}
                </div>
                {draft.team.filter(Boolean).length === 0 ? (
                  <p className="hint">{t.teamEmpty}</p>
                ) : (
                  <p className="hint">{t.teamHint}</p>
                )}
                <label className="check check--small" title={t.ultimatesChargedHint}>
                  <input
                    type="checkbox"
                    checked={draft.ultimatesCharged ?? false}
                    onChange={(event) => change({ ...draft, ultimatesCharged: event.target.checked })}
                  />
                  {t.ultimatesCharged}
                </label>
                <label className="check check--small" title={t.unlimitedSpHint}>
                  <input
                    type="checkbox"
                    checked={draft.unlimitedSp ?? false}
                    onChange={(event) => change({ ...draft, unlimitedSp: event.target.checked })}
                  />
                  {t.unlimitedSp}
                </label>
              </section>
              </div>

              <ExportPanel bundle={bundle} draft={draft} />
            </>
          )}

          <ImportPanel bundle={bundle} onImport={importText} />

          {!draft && file && fileTrack && (
            <section className="panel panel--full">
              <h3>{t.comboPriority}</h3>
              <ComboPriority
                bundle={bundle}
                team={fileTrack.rotation.team}
                priority={fileTrack.rotation.priority}
              />
              <p className="hint">{t.readOnly}</p>
            </section>
          )}

          <TrackPanels bundle={bundle} view={view} cursor={cursor} />
        </>
      )}
    </div>
  );
}
