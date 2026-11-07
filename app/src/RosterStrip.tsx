/**
 * The roster as a wall of portraits above the track.
 *
 * Two jobs. Hovering a portrait shows the build the track is simulating with
 * — the browser edit if there is one, the Enka snapshot otherwise — and says
 * which fields are known and which are filled in by defaults. Dragging a
 * portrait onto the track puts that operator into a team slot.
 */

import { useMemo, useState } from 'react';

import type { Build, Bundle, Operator } from '@engine/index.js';

import { iconUrl, listed } from './data.js';
import { InfoBody, Info } from './Info.js';
import { useT } from './i18n/index.js';
import { useNames } from './i18n/names.js';
import { useApp } from './store.js';
import { ELEMENT_COLOR } from './colors.js';
import { startOperatorDrag } from './TrackCanvas.js';

/** The build behind a portrait, as a tooltip. */
export function BuildCard({
  bundle,
  operator,
  build,
  edited,
  slot,
}: {
  bundle: Bundle;
  operator: Operator;
  build: Build;
  edited: boolean;
  slot: number | null;
}): JSX.Element {
  const t = useT();
  const n = useNames();
  const fieldLabel: Record<string, string> = {
    level: t.common.level,
    elite: t.common.elite,
    potential: t.common.potential,
    skills: t.common.skillLevels,
    weapon: t.common.weapon,
    gear: t.common.gear,
  };
  const weapon = build.weaponKey ? bundle.weapons[build.weaponKey] : null;
  const sets = new Map<string, number>();
  for (const item of build.gear) {
    const piece = item ? bundle.gear.pieces[item.key] : null;
    const name = piece?.set ? n.set(piece.set, bundle.gear.sets[piece.set]?.name ?? piece.set) : null;
    if (name) sets.set(name, (sets.get(name) ?? 0) + 1);
  }
  const assumed = Object.entries(build.provenance)
    .filter(([, origin]) => origin === 'default')
    .map(([field]) => fieldLabel[field] ?? field);

  return (
    <InfoBody
      title={n.operator(operator.key, operator.name)}
      kind={`${n.term(operator.element)} · ${n.term(operator.class)}${slot ? ` · ${t.common.slot(slot)}` : ''}`}
      source={edited ? t.strip.editedHere : t.strip.fromShowcase}
    >
      <table className="infocard__stats">
        <tbody>
          <tr>
            <td>{t.common.level}</td>
            <td>
              {build.level} · {t.common.eliteRank(build.elite)} · {t.common.potentialRank(build.potential)}
            </td>
          </tr>
          <tr>
            <td>{t.common.skills}</td>
            <td>
              BA {build.skills.basic} · BS {build.skills.battle} · CS {build.skills.combo} · ULT{' '}
              {build.skills.ultimate}
            </td>
          </tr>
          <tr>
            <td>{t.common.weapon}</td>
            <td>{weapon ? t.strip.weaponLevel(n.weapon(weapon.key, weapon.name), build.weaponLevel) : '—'}</td>
          </tr>
          <tr>
            <td>{t.common.gear}</td>
            <td>
              {sets.size > 0
                ? [...sets].map(([name, count]) => `${name} ×${count}`).join(', ')
                : build.gear.some(Boolean)
                  ? t.strip.piecesNoSet
                  : '—'}
            </td>
          </tr>
        </tbody>
      </table>
      {assumed.length > 0 && (
        <p className="infocard__bad">{t.strip.assumed(assumed.join(', '))}</p>
      )}
    </InfoBody>
  );
}

/**
 * Portraits, roster first.
 *
 * Owned operators only by default: the strip exists to build teams out of
 * what is in the account. The toggle brings in the rest for trying comps.
 */
export function RosterStrip({
  bundle,
  team,
  onPick,
}: {
  bundle: Bundle;
  /** Current team, slot 01 first: those portraits carry their slot number. */
  team: string[];
  /** Click: put into the first free slot. */
  onPick?: (key: string) => void;
}): JSX.Element {
  const builds = useApp((state) => state.builds);
  const buildFor = useApp((state) => state.buildFor);
  const t = useT();
  const n = useNames();
  const hasRoster = Object.keys(bundle.roster?.operators ?? {}).length > 0;
  // Without a roster there is nothing to filter by: everyone is shown.
  const [mineOnly, setMineOnly] = useState(true);
  const everyone = !hasRoster || !mineOnly;

  const operators = useMemo(() => {
    const owned = new Set(Object.keys(bundle.roster?.operators ?? {}));
    return Object.values(bundle.operators)
      .filter((operator) => !operator.upcoming && (everyone || owned.has(operator.key)) && listed(operator.key, owned))
      .sort(
        (a, b) =>
          Number(owned.has(b.key)) - Number(owned.has(a.key)) ||
          b.rarity - a.rarity ||
          a.element.localeCompare(b.element) ||
          a.name.localeCompare(b.name),
      );
  }, [bundle, everyone]);

  return (
    <div className="roster">
      <div className="roster__tiles">
        {operators.map((operator) => {
          const slot = team.indexOf(operator.key) + 1 || null;
          return (
            <Info
              key={operator.key}
              content={
                <BuildCard
                  bundle={bundle}
                  operator={operator}
                  build={buildFor(operator.key, bundle)}
                  edited={Boolean(builds[operator.key])}
                  slot={slot}
                />
              }
            >
              <button
                type="button"
                className={`tile${slot ? ' tile--in' : ''}`}
                style={{ '--accent': ELEMENT_COLOR[operator.element] ?? '#888' } as React.CSSProperties}
                draggable
                onDragStart={(event) => startOperatorDrag(event, { operator: operator.key, fromSlot: slot })}
                onClick={() => onPick?.(operator.key)}
                aria-label={n.operator(operator.key, operator.name)}
              >
                {operator.icon ? (
                  <img src={iconUrl(operator.icon)} alt="" width={44} height={44} draggable={false} />
                ) : (
                  <span className="tile__name">{n.operator(operator.key, operator.name).slice(0, 3)}</span>
                )}
                {slot && <span className="tile__slot">{String(slot).padStart(2, '0')}</span>}
              </button>
            </Info>
          );
        })}
      </div>
      <div className="roster__foot">
        <span className="muted">{t.strip.hint}</span>
        {hasRoster && (
          <button type="button" className={everyone ? 'chip chip--on' : 'chip'} onClick={() => setMineOnly((v) => !v)}>
            {everyone ? t.common.allOperators : t.common.onlyMine}
          </button>
        )}
      </div>
    </div>
  );
}
