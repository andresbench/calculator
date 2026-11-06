/**
 * Build editor and stat sheet.
 *
 * Two rules shape this screen.
 *
 * **Fact and assumption are shown apart.** Every field carries a provenance
 * badge: taken from the game through the Enka showcase, written by hand, or
 * filled in from defaults. Without it a default skill level of 1 looks just
 * as convincing as a measured 12.
 *
 * **Whatever the engine does not account for is stated under the numbers.**
 * Talents and potentials now come from the hand-written effect layer, and the
 * panel separates the three states a parsed effect can be in: already in the
 * stat sheet, waiting on the track (stacks and triggers), and not expressible
 * by the vocabulary at all. Weapon effects and set bonuses are still missing,
 * and saying so is part of the deliverable.
 */

import { Fragment, useMemo, useState } from 'react';

import {
  analyse,
  SLOT_NAMES,
  SLOT_TYPES,
  weaponColumns,
  type AssumedStacks,
  type Build,
  type Bundle,
  type DynamicEffect,
  type Effect,
  type GearPiece,
  type Provenance,
} from '@engine/index.js';
import { ComparePanel, VariantBar } from './BuildVariants.js';
import { iconUrl } from './data.js';
import { describeApply, explainEffect } from './explain.js';
import { Info } from './Info.js';
import { ensureEditable, useApp } from './store.js';
import { currentT, useLang, useT } from './i18n/index.js';
import { currentNames, useNames, type Names } from './i18n/names.js';
import { say } from './messages.js';

function Origin({ origin }: { origin: Provenance | undefined }): JSX.Element | null {
  const t = useT();
  if (!origin) return null;
  const label = t.provenance[origin];
  return (
    <span className={`origin origin--${origin}`} title={label}>
      {label}
    </span>
  );
}



/**
 * One row per effect, not per `apply` line.
 *
 * Pogranichnik's Fervent Morale is two lines — ATK and Arts Intensity — but
 * one buff with one stack count, and offering two independent counters for it
 * would invite a state the game cannot be in.
 */
function unique(
  dynamic: DynamicEffect[],
): Array<{ effect: Effect; apply: DynamicEffect['apply']; max: number }> {
  const out = new Map<string, { effect: Effect; apply: DynamicEffect['apply']; max: number }>();
  for (const { effect, apply } of dynamic) {
    const max = apply.stacks?.max ?? 1;
    const seen = out.get(effect.id);
    if (!seen) out.set(effect.id, { effect, apply, max });
    else if (max > seen.max) seen.max = max;
  }
  return [...out.values()];
}

/**
 * Parsed effects, grouped by where each one actually lands.
 *
 * The split is the honest part. Being always-on does not mean being in the
 * stat sheet: a potential that multiplies one skill's own DMG Multiplier is
 * permanent but belongs to that instance, so it sits in its own group rather
 * than next to "ATK +15".
 *
 * Triggered effects are a switch, not a number. They do not exist until a
 * trigger fires, so the panel asks how many stacks to assume and says that it
 * is an assumption. And an effect the vocabulary cannot express is listed by
 * name rather than silently dropped, because the damage above is low by
 * exactly that much.
 */
function EffectsPanel({
  passive,
  passiveModifiers,
  dynamic,
  team,
  unmodeled,
  stale,
  missing,
  operatorName,
  assume,
  onAssume,
}: {
  passive: DynamicEffect[];
  passiveModifiers: DynamicEffect[];
  dynamic: DynamicEffect[];
  team: DynamicEffect[];
  unmodeled: Effect[];
  stale: Effect[];
  missing: boolean;
  operatorName: string;
  assume: AssumedStacks;
  onAssume: (id: string, stacks: number) => void;
}): JSX.Element {
  const t = useT().effects;
  const row = (effect: Effect, text: string, key: string): JSX.Element => (
    <li key={key}>
      <Info content={explainEffect(effect)}>
        <span className="effects__name">
          {effectName(effect, currentNames())}{' '}
          <span className="effects__cond">{effectCondition(effect)}</span>
        </span>
        <span className="effects__value">{text}</span>
        <span className={`conf conf--${effect.confidence}`} title={effect.confidence}>
          ●
        </span>
      </Info>
    </li>
  );

  return (
    <section className="panel">
      <h3>{t.title}</h3>
      {missing && <p className="hint hint--warn">{t.missing(operatorName)}</p>}
      <div className="effects">
          {stale.length > 0 && (
            <p className="hint hint--warn">{t.stale(stale.length)}</p>
          )}
          {passive.length > 0 && (
            <div className="effects__group">
              <b>{t.inSheet}</b>
              <ul className="effects__list">
                {passive.map(({ effect, apply }, index) =>
                  row(effect, describeApply(apply), `${effect.id}:${index}`),
                )}
              </ul>
            </div>
          )}
          {passiveModifiers.length > 0 && (
            <div className="effects__group">
              <b>{t.tweaks}</b>
              <ul className="effects__list">
                {passiveModifiers.map(({ effect, apply }, index) =>
                  row(effect, describeApply(apply), `${effect.id}:${index}`),
                )}
              </ul>
            </div>
          )}
          {dynamic.length > 0 && (
            <div className="effects__group">
              <b>{t.triggered}</b>
              <ul className="effects__list">
                {unique(dynamic).map(({ effect, apply, max }) => (
                  <li key={effect.id}>
                    <Info content={explainEffect(effect)}>
                      <span className="effects__name">
                        {effectName(effect, currentNames())}{' '}
                        <span className="effects__cond">
                          {apply.trigger ?? t.trigger}
                          {effect.apply.some((row) => row.controlled) && ` · ${t.asControlled}`}
                        </span>
                      </span>
                    </Info>
                    <select
                      value={Math.min(assume[effect.id] ?? 0, max)}
                      onChange={(event) => onAssume(effect.id, Number(event.target.value))}
                    >
                      {Array.from({ length: max + 1 }, (_, index) => (
                        <option key={index} value={index}>
                          {index === 0 ? t.off : max === 1 ? t.on : t.times(index)}
                        </option>
                      ))}
                    </select>
                    <span className={`conf conf--${effect.confidence}`} title={effect.confidence}>
                      ●
                    </span>
                  </li>
                ))}
              </ul>
              <p className="hint">{t.assumption}</p>
            </div>
          )}
          {team.length > 0 && (
            <div className="effects__group">
              <b>{t.team}</b>
              <ul className="effects__list">
                {team.map(({ effect, apply }, index) =>
                  row(
                    effect,
                    `${describeApply(apply)}${apply.target === 'others' ? t.notWearer : ''}`,
                    `${effect.id}:team:${index}`,
                  ),
                )}
              </ul>
              <p className="hint">{t.teamHint}</p>
            </div>
          )}
          {unmodeled.length > 0 && (
            <div className="effects__group effects--off">
              <b>{t.unmodeled}</b>
              <ul className="effects__list">
                {unmodeled.map((effect) => row(effect, effect.unmodeled ?? '', effect.id))}
              </ul>
            </div>
          )}
      </div>
    </section>
  );
}

/** A weapon line is named after the weapon, a talent after itself. */
function effectName(effect: Effect, n: Names): string {
  const { kind, name } = effect.source;
  if (kind === 'weapon') return n.weapon(effect.item ?? '', effect.item ?? name);
  if (kind === 'talent') return n.talent(name);
  if (kind === 'potential') return n.potential(name);
  if (kind === 'gear-set') return n.set(effect.item ?? name, name);
  return name;
}

function effectCondition(effect: Effect): string | null {
  return effect.source.kind === 'weapon' ? effect.source.name : effect.source.condition;
}

function formatValue(value: number, unit: 'frac' | 'flat'): string {
  if (unit === 'frac') return `${(value * 100).toFixed(1).replace(/\.0$/, '')} %`;
  return value.toLocaleString(currentT().locale, { maximumFractionDigits: 1 });
}

function Number_({ value }: { value: number }): JSX.Element {
  const t = useT();
  return <>{value.toLocaleString(t.locale, { maximumFractionDigits: 0 })}</>;
}

/**
 * Skill level of each weapon component — the "6/9" the game draws next to it.
 *
 * Set by the infused Essence: stat components at `cost + 3`, the named effect
 * at `cost + rank` (measurement log, item 6). Without a matching Essence term
 * the level is unknown and the component stays out of the numbers until it is
 * entered here.
 */
function WeaponColumns({
  build,
  bundle,
  onChange,
}: {
  build: Build;
  bundle: Bundle;
  onChange: (patch: Partial<Build>) => void;
}): JSX.Element {
  const t = useT().editor;
  const weapon = bundle.weapons[build.weaponKey!]!;
  const { columns, resolved } = weaponColumns(build, bundle);
  const components = weapon.components.filter((component) => component.valuesByRank[0]?.length);
  return (
    <table className="stats">
      <tbody>
        {components.map((component) => {
          const max = component.valuesByRank[0]!.length;
          const column = columns[component.key] ?? null;
          const hit = resolved?.[component.key];
          return (
            <tr key={component.key}>
              <td>{component.key}</td>
              <td>
                <select
                  value={column ?? ''}
                  onChange={(event) =>
                    onChange({
                      weaponColumns: {
                        ...columns,
                        [component.key]: event.target.value ? Number(event.target.value) : null,
                      },
                    })
                  }
                >
                  <option value="">?</option>
                  {Array.from({ length: max }, (_, index) => (
                    <option key={index} value={index + 1}>
                      {index + 1}/{max}
                    </option>
                  ))}
                </select>
              </td>
              <td className="muted">
                {build.weaponColumns
                  ? t.columnByHand
                  : hit
                    ? t.columnFrom(hit.via, hit.cost ?? null, hit.confidence)
                    : t.columnUnknown}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Gear picker for a single slot. */
function GearSlot({
  index,
  build,
  bundle,
  onChange,
}: {
  index: number;
  build: Build;
  bundle: Bundle;
  onChange: (patch: Partial<Build>) => void;
}): JSX.Element {
  const t = useT();
  const n = useNames();
  const slot = build.gear[index] ?? null;
  const piece = slot ? bundle.gear.pieces[slot.key] : null;
  const operator = bundle.operators[build.operatorKey];

  const options = useMemo(() => {
    const wanted = SLOT_TYPES[index];
    return Object.values(bundle.gear.pieces)
      .filter((item) => item.type === wanted)
      .sort((a, b) => {
        // Items carrying the operator's own main attribute float to the top:
        // measurements say a foreign attribute costs more than almost any
        // set bonus is worth.
        const own = (item: GearPiece): number =>
          item.stats.some(
            (stat) =>
              stat.slot === 'primary' &&
              (stat.stat === operator?.mainAttribute || stat.stat === 'Main Attribute'),
          )
            ? 0
            : 1;
        return own(a) - own(b) || b.rarity - a.rarity || a.name.localeCompare(b.name);
      });
  }, [bundle, index, operator]);

  const maxTier = piece?.stats[0] ? piece.stats[0].values.length - 1 : 0;

  return (
    <div className="slot">
      <div className="slot__head">
        <span className="slot__name">{SLOT_NAMES[index]}</span>
        {piece && maxTier > 0 && (
          <label className="slot__tier">
            {t.editor.tier}
            <select
              value={slot?.tier ?? maxTier}
              onChange={(event) => {
                const gear = [...build.gear];
                gear[index] = { key: slot!.key, tier: Number(event.target.value) };
                onChange({ gear });
              }}
            >
              {Array.from({ length: maxTier + 1 }, (_, tier) => (
                <option key={tier} value={tier}>
                  {tier + 1}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      <div className="slot__body">
        {piece?.icon && <img src={iconUrl(piece.icon)} alt="" width={40} height={40} />}
        <select
          className="slot__select"
          value={slot?.key ?? ''}
          onChange={(event) => {
            const gear = [...build.gear];
            const key = event.target.value;
            if (!key) gear[index] = null;
            else {
              const chosen = bundle.gear.pieces[key];
              const tier = chosen?.stats[0] ? chosen.stats[0].values.length - 1 : 0;
              gear[index] = { key, tier };
            }
            onChange({ gear });
          }}
        >
          <option value="">{t.common.empty}</option>
          {options.map((item) => (
            <option key={item.key} value={item.key}>
              {n.gear(item.key, item.name)}
            </option>
          ))}
        </select>
      </div>

      {piece && (
        <ul className="slot__stats">
          {piece.stats.map((stat) => {
            const tier = Math.min(slot?.tier ?? maxTier, stat.values.length - 1);
            const value = stat.values[tier] ?? 0;
            const resolved =
              stat.stat === 'Main Attribute'
                ? (operator?.mainAttribute ?? stat.stat)
                : stat.stat === 'Secondary Attribute'
                  ? (operator?.subAttribute ?? stat.stat)
                  : stat.stat;
            const foreign =
              stat.slot === 'primary' &&
              operator?.mainAttribute != null &&
              ['Agility', 'Strength', 'Intellect', 'Will'].includes(resolved) &&
              resolved !== operator.mainAttribute;
            return (
              <li key={stat.slot} className={foreign ? 'stat stat--foreign' : 'stat'}>
                <span>{n.term(resolved)}</span>
                <b>{formatValue(value, stat.unit === 'frac' ? 'frac' : 'flat')}</b>
                {foreign && <span className="warn" title={t.editor.foreignTitle}>{t.editor.foreign}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function BuildEditor({
  bundle,
  operatorKey,
  onBack,
}: {
  bundle: Bundle;
  operatorKey: string;
  onBack: () => void;
}): JSX.Element {
  const buildFor = useApp((state) => state.buildFor);
  const builds = useApp((state) => state.builds);
  const update = useApp((state) => state.update);
  const dummy = useApp((state) => state.dummy);
  const setDummy = useApp((state) => state.setDummy);
  const [openBreakdown, setOpenBreakdown] = useState<string | null>(null);
  const t = useT();
  const te = t.editor;
  const n = useNames();

  const build = builds[operatorKey] ?? buildFor(operatorKey, bundle);

  const change = (patch: Partial<Build>): void => {
    ensureEditable(operatorKey, bundle);
    update(operatorKey, patch);
  };

  // The analysis carries text (what is not accounted for): redo it in a new language.
  const lang = useLang((state) => state.lang);
  const analysis = useMemo(() => analyse(build, bundle, dummy), [build, bundle, dummy, lang, n]);
  if (!analysis) return <p>{te.notFound}</p>;

  const { operator, sheet, sets, skills, effects, unaccounted } = analysis;
  const weapons = Object.values(bundle.weapons)
    .filter((weapon) => weapon.type === operator.weaponType)
    .sort((a, b) => b.rarity - a.rarity || a.name.localeCompare(b.name));

  return (
    <div className="editor">
      <header className="editor__head">
        <button type="button" className="chip" onClick={onBack}>
          {t.common.back}
        </button>
        {operator.icon && <img src={iconUrl(operator.icon)} alt="" width={56} height={56} />}
        <div>
          <h2>{n.operator(operator.key, operator.name)}</h2>
          <div className="card__meta">
            <span>{n.term(operator.element)}</span>
            <span className="dot">·</span>
            <span>{n.term(operator.class)}</span>
            <span className="dot">·</span>
            <span>
              {t.common.main} <b>{n.term(operator.mainAttribute ?? '—')}</b>, {t.common.sub}{' '}
              <b>{n.term(operator.subAttribute ?? '—')}</b>
            </span>
          </div>
        </div>
      </header>

      <VariantBar bundle={bundle} operatorKey={operatorKey} />

      <div className="editor__grid">
        <section className="panel">
          <h3>{te.operator}</h3>
          <div className="fields">
            <label>
              {t.common.level} <Origin origin={build.provenance.level} />
              <input
                type="number"
                min={1}
                max={90}
                value={build.level}
                onChange={(event) => change({ level: Number(event.target.value) })}
              />
            </label>
            <label>
              {t.common.elite} <Origin origin={build.provenance.elite} />
              <select
                value={build.elite}
                onChange={(event) => change({ elite: Number(event.target.value) })}
              >
                {[0, 1, 2, 3, 4].map((tier) => (
                  <option key={tier} value={tier}>
                    {t.common.eliteRank(tier)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t.common.potential} <Origin origin={build.provenance.potential} />
              <select
                value={build.potential}
                onChange={(event) => change({ potential: Number(event.target.value) })}
              >
                {[0, 1, 2, 3, 4, 5].map((rank) => (
                  <option key={rank} value={rank}>
                    {t.common.potentialRank(rank)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="fields">
            {(['basic', 'battle', 'combo', 'ultimate'] as const).map((field) => (
              <label key={field}>
                {te.skillShort[field]}
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={build.skills[field]}
                  onChange={(event) =>
                    change({ skills: { ...build.skills, [field]: Number(event.target.value) } })
                  }
                />
              </label>
            ))}
          </div>
          <p className="hint">
            {te.skillsOrigin} <Origin origin={build.provenance.skills} />. {te.skillsHint}
          </p>
        </section>

        <section className="panel">
          <h3>
            {te.weapon} <Origin origin={build.provenance.weapon} />
          </h3>
          <select
            value={build.weaponKey ?? ''}
            // Columns belong to one weapon instance: a new weapon starts from
            // whatever the roster knows about it, which is usually nothing.
            onChange={(event) =>
              change({ weaponKey: event.target.value || null, weaponColumns: undefined })
            }
          >
            <option value="">{t.common.none}</option>
            {weapons.map((weapon) => (
              <option key={weapon.key} value={weapon.key}>
                {'★'.repeat(weapon.rarity)} {n.weapon(weapon.key, weapon.name)}
              </option>
            ))}
          </select>
          <label className="inline">
            {t.common.level}
            <input
              type="number"
              min={1}
              max={90}
              value={build.weaponLevel}
              onChange={(event) => change({ weaponLevel: Number(event.target.value) })}
            />
          </label>
          {build.weaponKey && bundle.weapons[build.weaponKey] && (
            <WeaponColumns build={build} bundle={bundle} onChange={change} />
          )}
        </section>

        <section className="panel panel--wide">
          <h3>
            {te.gear} <Origin origin={build.provenance.gear} />
          </h3>
          <div className="slots">
            {[0, 1, 2, 3].map((index) => (
              <GearSlot key={index} index={index} build={build} bundle={bundle} onChange={change} />
            ))}
          </div>
          {sets.length > 0 && (
            <ul className="sets">
              {sets.map((set) => (
                <li key={set.name} className={set.active ? 'set set--on' : 'set'}>
                  <b>{n.set(set.name, set.name)}</b> {set.count}/3 {set.active ? te.bonusActive : ''}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h3>{te.stats}</h3>
          <table className="stats">
            <tbody>
              <tr>
                <td>{te.attack}</td>
                <td>
                  <b>
                    <Number_ value={sheet.attack} />
                  </b>
                </td>
                <td className="muted">
                  ({sheet.baseAttack.toFixed(0)} × {sheet.attributeBonus.toFixed(4)})
                </td>
              </tr>
              {(['AGL', 'STR', 'INT', 'WIL'] as const).map((key) => {
                const name = { AGL: 'Agility', STR: 'Strength', INT: 'Intellect', WIL: 'Will' }[key];
                const role =
                  name === operator.mainAttribute
                    ? t.common.main
                    : name === operator.subAttribute
                      ? t.common.sub
                      : '';
                return (
                  <tr key={key} className={role ? '' : 'muted'}>
                    <td>
                      {n.term(name)} {role && <span className="tag">{role}</span>}
                    </td>
                    <td>
                      <Number_ value={sheet.attributes[key]} />
                    </td>
                    <td className="muted">{role ? '' : te.notCounted}</td>
                  </tr>
                );
              })}
              <tr>
                <td>Arts Intensity</td>
                <td>{sheet.artsIntensity.toFixed(1)}</td>
                <td className="muted">{te.artsIntensityNote}</td>
              </tr>
              <tr>
                <td>Critical Rate</td>
                <td>{(sheet.critRate * 100).toFixed(1)} %</td>
                <td className="muted">{te.critDmg(sheet.critDmg * 100)}</td>
              </tr>
            </tbody>
          </table>
          {sheet.warnings.length > 0 && (
            <ul className="warnings">
              {sheet.warnings.map((warning) => say(bundle, warning)).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
        </section>

        <EffectsPanel
          passive={effects.passive}
          passiveModifiers={effects.passiveModifiers}
          dynamic={effects.dynamic}
          team={effects.team}
          unmodeled={effects.unmodeled}
          stale={effects.stale}
          missing={effects.missing}
          operatorName={n.operator(operator.key, operator.name)}
          assume={dummy.assume ?? {}}
          onAssume={(id, stacks) =>
            setDummy({ assume: { ...(dummy.assume ?? {}), [id]: stacks } })
          }
        />

        <section className="panel">
          <h3>{te.dummy}</h3>
          <select
            value={dummy.enemyKey ?? ''}
            onChange={(event) => setDummy({ enemyKey: event.target.value || null })}
          >
            <option value="">{te.dummyPlain}</option>
            {Object.values(bundle.enemies)
              .sort((a, b) => a.class.localeCompare(b.class) || a.name.localeCompare(b.name))
              .map((enemy) => (
                <option key={enemy.key} value={enemy.key}>
                  [{enemy.class}] {n.enemy(enemy.key, enemy.name)}
                </option>
              ))}
          </select>
          <div className="fields">
            <label className="check">
              <input
                type="checkbox"
                checked={dummy.staggered}
                onChange={(event) => setDummy({ staggered: event.target.checked })}
              />
              {te.staggered}
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={dummy.crit}
                onChange={(event) => setDummy({ crit: event.target.checked })}
              />
              {te.countCrit}
            </label>
          </div>
          <p className="hint">{te.resistNote}</p>
        </section>
      </div>

      <section className="panel panel--full">
        <h3>{te.damage}</h3>
        <table className="damage">
          <thead>
            <tr>
              <th>{te.headSkill}</th>
              <th>{te.headInstance}</th>
              <th>{te.headMultiplier}</th>
              <th>{te.headDamage}</th>
              <th>{te.headConfidence}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {skills.map((skill, index) => (
              <Fragment key={skill.id}>
                <tr>
                  <td>
                    {skills[index - 1]?.type !== skill.type && (
                      <>
                        {skill.icon && (
                          <img src={iconUrl(skill.icon)} alt="" width={20} height={20} />
                        )}
                        <span className="muted">{n.term(skill.type)}</span> {n.skill(skill.name)}
                      </>
                    )}
                  </td>
                  <td className="muted">
                    {skill.label}
                    {skill.count !== 1 && (
                      <span
                        className="tag tag--soft"
                        title={skill.count == null ? te.hitsUnknown : te.perHit}
                      >
                        ×{skill.count ?? '?'}
                      </span>
                    )}
                  </td>
                  <td>
                    {(skill.multiplier * 100).toFixed(0)} %
                    {skill.skillMultiplier !== 1 && (
                      <Info
                        content={
                          <ul className="infocard__list">
                            {skill.multiplierFrom.map((from) => (
                              <li key={`${from.id}:${from.value}`}>
                                {from.source}: ×{from.value}
                                {from.targetHas ? te.needs(from.targetHas) : ''}
                              </li>
                            ))}
                          </ul>
                        }
                      >
                        <span className="tag tag--soft">×{skill.skillMultiplier.toFixed(2)}</span>
                      </Info>
                    )}
                  </td>
                  <td>
                    <b>
                      <Number_ value={skill.result.damage} />
                    </b>
                  </td>
                  <td className={`conf conf--${skill.result.confidence}`}>
                    {skill.result.confidence}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="chip"
                      onClick={() => setOpenBreakdown(openBreakdown === skill.id ? null : skill.id)}
                    >
                      {te.breakdown}
                    </button>
                  </td>
                </tr>
                {openBreakdown === skill.id && (
                  <tr>
                    <td colSpan={6}>
                      <ul className="breakdown">
                        {skill.result.factors.map((factor) => (
                          <li key={factor.name}>
                            <span className={`conf conf--${factor.confidence}`}>●</span>
                            <span>{t.factor[factor.id] ?? factor.name}</span>
                            <b>×{factor.value.toLocaleString(t.locale, { maximumFractionDigits: 4 })}</b>
                            {factor.evidence && <em>{say(bundle, factor.evidence)}</em>}
                          </li>
                        ))}
                      </ul>
                      {skill.result.notes.map((note) => (
                        <p className="hint" key={note.code}>
                          {say(bundle, note)}
                        </p>
                      ))}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>

        {unaccounted.length > 0 && (
          <div className="unaccounted">
            <b>{te.unaccounted}</b>
            <ul>
              {unaccounted.map((item) => say(bundle, item)).map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <ComparePanel bundle={bundle} operatorKey={operatorKey} current={build} dummy={dummy} />
    </div>
  );
}
