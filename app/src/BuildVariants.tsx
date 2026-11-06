/**
 * Named build variants of one operator, and a side-by-side comparison.
 *
 * Why variants exist: one operator often has two honest builds — Arcane on
 * Will or on Intellect — and the question is which one hits harder. The
 * showcase from Enka is always there as a read-only variant, so an import
 * never overwrites a saved one, and editing the showcase starts a new
 * variant instead of changing a fact from the game.
 *
 * The comparison runs both builds through the same `analyse` with the same
 * dummy and the same assumed stacks. Assumed stacks are keyed by effect id,
 * so a triggered weapon effect switched on for one weapon does nothing for
 * the other — the panel says so rather than pretending the dummy is neutral.
 */

import { useMemo, useState } from 'react';

import {
  analyse,
  ATTRIBUTE_KEY,
  screenElementBonus,
  showcaseBuild,
  type Build,
  type BuildAnalysis,
  type Bundle,
  type DummyState,
} from '@engine/index.js';

import { currentT, useLang, useT } from './i18n/index.js';
import { currentNames } from './i18n/names.js';
import { useApp } from './store.js';

/** Showcase id in the selectors: the roster build, not a stored variant. */
const SHOWCASE = '';

export function VariantBar({ bundle, operatorKey }: { bundle: Bundle; operatorKey: string }): JSX.Element {
  const entry = useApp((state) => state.variants[operatorKey]);
  const selectVariant = useApp((state) => state.selectVariant);
  const saveAs = useApp((state) => state.saveAs);
  const renameVariant = useApp((state) => state.renameVariant);
  const deleteVariant = useApp((state) => state.deleteVariant);
  const [naming, setNaming] = useState<'new' | 'rename' | null>(null);
  const [name, setName] = useState('');
  const t = useT();
  const tv = t.variants;

  const variants = entry?.variants ?? [];
  const active = variants.find((item) => item.id === entry?.active) ?? null;
  const inRoster = Boolean(bundle.roster?.operators[operatorKey]);

  const submit = (): void => {
    if (naming === 'new') saveAs(operatorKey, name, bundle);
    else if (naming === 'rename' && active) renameVariant(operatorKey, active.id, name);
    setNaming(null);
    setName('');
  };

  return (
    <div className="variants">
      <button
        type="button"
        className={active ? 'chip' : 'chip chip--on'}
        onClick={() => selectVariant(operatorKey, null)}
        title={tv.showcaseTitle}
      >
        {inRoster ? tv.showcase : tv.default}
      </button>
      {variants.map((item) => (
        <button
          key={item.id}
          type="button"
          className={item.id === active?.id ? 'chip chip--on' : 'chip'}
          onClick={() => selectVariant(operatorKey, item.id)}
        >
          {item.name}
        </button>
      ))}

      {naming ? (
        <form
          className="variants__form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <input
            autoFocus
            type="text"
            value={name}
            placeholder={naming === 'new' ? tv.namePlaceholder : tv.newName}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setNaming(null)}
            aria-label={tv.nameLabel}
          />
          <button type="submit" className="chip chip--on">
            {naming === 'new' ? t.common.save : t.common.rename}
          </button>
          <button type="button" className="chip" onClick={() => setNaming(null)}>
            {t.common.cancel}
          </button>
        </form>
      ) : (
        <>
          <button type="button" className="chip" onClick={() => setNaming('new')}>
            {tv.saveNew}
          </button>
          {active && (
            <>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  setName(active.name);
                  setNaming('rename');
                }}
              >
                {t.common.rename}
              </button>
              <button
                type="button"
                className="chip"
                onClick={() => {
                  if (window.confirm(tv.confirmDelete(active.name))) {
                    deleteVariant(operatorKey, active.id);
                  }
                }}
              >
                {t.common.delete}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}

interface Row {
  label: string;
  a: number;
  b: number;
  /** How to print the value. */
  format: 'int' | 'pct' | 'one';
}

function format(value: number, kind: Row['format']): string {
  if (kind === 'pct') return `${(value * 100).toFixed(1)} %`;
  const locale = currentT().locale;
  if (kind === 'one') return value.toLocaleString(locale, { maximumFractionDigits: 1 });
  return value.toLocaleString(locale, { maximumFractionDigits: 0 });
}

function Delta({ a, b }: { a: number; b: number }): JSX.Element {
  if (Math.abs(a) < 1e-9 && Math.abs(b) < 1e-9) return <td className="muted">—</td>;
  if (Math.abs(a) < 1e-9) return <td className="muted">{currentT().variants.new}</td>;
  const ratio = b / a - 1;
  if (Math.abs(ratio) < 0.0005) return <td className="muted">=</td>;
  return <td className={ratio > 0 ? 'delta delta--up' : 'delta delta--down'}>{`${ratio > 0 ? '+' : ''}${(ratio * 100).toFixed(1)} %`}</td>;
}

function statRows(a: BuildAnalysis, b: BuildAnalysis): Row[] {
  const { operator } = a;
  const rows: Row[] = [{ label: 'Attack', a: a.sheet.attack, b: b.sheet.attack, format: 'int' }];
  for (const [role, name] of [
    ['main', operator.mainAttribute],
    ['sub', operator.subAttribute],
  ] as const) {
    const key = name ? ATTRIBUTE_KEY[name] : undefined;
    if (key) rows.push({ label: `${name} (${role})`, a: a.sheet.attributes[key], b: b.sheet.attributes[key], format: 'int' });
  }
  rows.push(
    { label: 'AttributeBonus', a: a.sheet.attributeBonus, b: b.sheet.attributeBonus, format: 'one' },
    { label: `${operator.element} DMG`, a: screenElementBonus(a.sheet, operator.element), b: screenElementBonus(b.sheet, operator.element), format: 'pct' },
    { label: 'Arts Intensity', a: a.sheet.artsIntensity, b: b.sheet.artsIntensity, format: 'one' },
    { label: 'Critical Rate', a: a.sheet.critRate, b: b.sheet.critRate, format: 'pct' },
    { label: 'Ultimate Gain', a: a.sheet.ultGainEfficiency, b: b.sheet.ultGainEfficiency, format: 'pct' },
    { label: 'HP', a: a.sheet.hp, b: b.sheet.hp, format: 'int' },
  );
  return rows;
}

function summary(build: Build, bundle: Bundle): string {
  const t = currentT();
  const n = currentNames();
  const weapon = build.weaponKey
    ? n.weapon(build.weaponKey, bundle.weapons[build.weaponKey]?.name ?? build.weaponKey)
    : t.variants.noWeapon;
  const sets = new Map<string, number>();
  for (const slot of build.gear) {
    const set = slot ? bundle.gear.pieces[slot.key]?.set : null;
    if (set) sets.set(set, (sets.get(set) ?? 0) + 1);
  }
  const gear = [...sets].map(([name, count]) => `${n.set(name)} ×${count}`).join(', ') || t.variants.noSet;
  return `${weapon} · ${gear} · ${t.common.potentialRank(build.potential)}`;
}

export function ComparePanel({
  bundle,
  operatorKey,
  current,
  dummy,
}: {
  bundle: Bundle;
  operatorKey: string;
  current: Build;
  dummy: DummyState;
}): JSX.Element | null {
  const entry = useApp((state) => state.variants[operatorKey]);
  const [other, setOther] = useState<string | null>(null);
  const tv = useT().variants;

  const activeId = entry?.active ?? SHOWCASE;
  const roster = bundle.roster?.operators[operatorKey];
  const options = [
    ...(activeId !== SHOWCASE ? [{ id: SHOWCASE, name: roster ? tv.showcase : tv.default }] : []),
    ...(entry?.variants ?? []).filter((item) => item.id !== activeId).map((item) => ({ id: item.id, name: item.name })),
  ];
  const chosen = options.find((option) => option.id === other) ?? options[0] ?? null;

  const otherBuild = useMemo<Build | null>(() => {
    if (!chosen) return null;
    // The showcase as the roster has it, even while a variant is active.
    if (chosen.id === SHOWCASE) return showcaseBuild(operatorKey, bundle);
    return entry?.variants.find((item) => item.id === chosen.id)?.build ?? null;
  }, [chosen, entry, bundle, operatorKey]);

  const lang = useLang((state) => state.lang);
  const a = useMemo(() => analyse(current, bundle, dummy), [current, bundle, dummy, lang]);
  const b = useMemo(() => (otherBuild ? analyse(otherBuild, bundle, dummy) : null), [otherBuild, bundle, dummy, lang]);

  if (options.length === 0) {
    return (
      <section className="panel panel--full">
        <h3>{tv.compare}</h3>
        <p className="hint">{tv.compareHint}</p>
      </section>
    );
  }
  if (!a || !b || !otherBuild) return null;

  const currentName =
    entry?.variants.find((item) => item.id === entry.active)?.name ?? (roster ? tv.showcase : tv.default);
  const skillRows = a.skills.map((skill) => {
    const twin = b.skills.find((item) => item.id === skill.id);
    return { id: skill.id, label: `${skill.type} · ${skill.label}`, a: skill.result.damage, b: twin?.result.damage ?? 0 };
  });

  return (
    <section className="panel panel--full">
      <h3>{tv.compare}</h3>
      <div className="compare__pick">
        <span>
          <b>{currentName}</b> <span className="muted">{summary(current, bundle)}</span>
        </span>
        <span>{tv.against}</span>
        <select value={chosen?.id ?? ''} onChange={(event) => setOther(event.target.value)}>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <span className="muted">{summary(otherBuild, bundle)}</span>
      </div>
      <table className="damage compare">
        <thead>
          <tr>
            <th />
            <th>{currentName}</th>
            <th>{chosen?.name}</th>
            <th>{tv.difference}</th>
          </tr>
        </thead>
        <tbody>
          {statRows(a, b).map((row) => (
            <tr key={row.label}>
              <td>{row.label}</td>
              <td>{format(row.a, row.format)}</td>
              <td>{format(row.b, row.format)}</td>
              <Delta a={row.a} b={row.b} />
            </tr>
          ))}
          <tr className="compare__divider">
            <td colSpan={4}>{tv.perInstance(dummy.crit)}</td>
          </tr>
          {skillRows.map((row) => (
            <tr key={row.id}>
              <td>{row.label}</td>
              <td>{format(row.a, 'int')}</td>
              <td>{format(row.b, 'int')}</td>
              <Delta a={row.a} b={row.b} />
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">{tv.sameDummy}</p>
    </section>
  );
}
