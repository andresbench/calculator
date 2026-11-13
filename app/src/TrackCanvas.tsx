/**
 * Rotation track: the drawing.
 *
 * One lane per operator, time across, a playhead you drag like in an audio
 * editor. Above the lanes sits the ribbon: buff and debuff windows, and the
 * Vulnerable stack count as a step graph.
 *
 * Everything here is **read out of the simulation**, never authored by the
 * interface. If the engine did not produce a window, the track cannot draw
 * one. That is what keeps a pretty timeline from quietly inventing state.
 *
 * The cursor answers one question at a time: at this instant, what is on the
 * target, what does the team have, and which combo is open.
 */

import { Fragment, useMemo, useRef, useState } from 'react';

import { openedBy, stepHitOffsets, type Bundle } from '@engine/index.js';

import { ELEMENT_COLOR, STACK_COLOR } from './colors.js';
import { iconUrl } from './data.js';
import { explainFrame, explainSp, explainTerm } from './explain.js';
import { Info, InfoBody } from './Info.js';
import { useT } from './i18n/index.js';
import { opName, useNames } from './i18n/names.js';
import { say } from './messages.js';
import { frameAt, type StackSeries, type TrackView } from './track.js';
import { compact, type BuffMarker, type StepDamage, type TrackDamage } from './trackDamage.js';

/** Pixels per second. Zoom multiplies it. */
const BASE_SCALE = 26;

/**
 * Width of the sticky lane labels on the left.
 *
 * Everything positioned by time — ruler, ribbon, counters, actions, playhead —
 * starts after it, or the playhead points at one moment while the actions sit
 * at another. That misalignment is invisible until you check a tick against a
 * block, which is exactly why it is a named constant and not a number
 * repeated in five places.
 */
const LANE_HEAD = 150;

/** Max stacks of anything: four, per the glossary. */
const MAX_STACKS = 4;
const STACK_ROW = 26;

/**
 * One counter drawn as a step graph.
 *
 * Height encodes the count, so four stacks is visibly a full cell and one is
 * a quarter. A drop to zero is where a Crush or a reaction ate them, and the
 * number of stacks eaten is the Status Level that multiplied its damage.
 */
function StackRow({
  series,
  scale,
  left,
  length,
  info,
}: {
  series: StackSeries;
  scale: number;
  left: number;
  length: number;
  info: JSX.Element;
}): JSX.Element {
  const t = useT().canvas;
  const n = useNames();
  const colour = STACK_COLOR[series.element ?? series.label] ?? '#888';
  const segments: JSX.Element[] = [];

  for (let i = 0; i < series.points.length; i += 1) {
    const point = series.points[i]!;
    const next = series.points[i + 1];
    const to = next ? next.t : length;
    if (point.value === 0) continue;
    segments.push(
      <div
        key={i}
        className="stackbar"
        style={{
          left: left + point.t * scale,
          width: Math.max((to - point.t) * scale, 3),
          height: (point.value / MAX_STACKS) * (STACK_ROW - 8),
          background: colour,
        }}
        title={t.stackTitle(n.term(series.label), point.value, point.t)}
      />,
    );
  }

  const eaten = series.points.filter((point) => point.consumed);

  return (
    <div className="stackrow" style={{ height: STACK_ROW }}>
      <Info content={info}>
        <div className="stackrow__label" style={{ color: colour }}>
          {n.term(series.label)}
        </div>
      </Info>
      {segments}
      {eaten.map((point, index) => (
        <div
          key={`eat-${index}`}
          className="stackrow__eaten"
          style={{ left: left + point.t * scale }}
          title={t.consumedTitle(point.consumed ?? 0)}
        >
          −{point.consumed}
        </div>
      ))}
    </div>
  );
}

const ROMAN = ['', 'I', 'II', 'III', 'IV'];

/**
 * The SP bar, as the game draws it: three segments of 100.
 *
 * Not a graph over time. A player does not read SP as a curve, they read it
 * as "how many bars do I have", because a Battle Skill costs one bar. So the
 * bar shows the value **at the playhead** and fills segment by segment.
 */
export function SpBar({ sp }: { sp: number }): JSX.Element {
  const t = useT().canvas;
  const BAR = 100;
  const bars = [0, 1, 2].map((index) => {
    const filled = Math.max(0, Math.min(BAR, sp - index * BAR));
    return { index, filled, full: filled >= BAR };
  });

  return (
    <Info content={explainSp(sp)}>
      <div className="spbar" role="img" aria-label={t.spLabel(sp)}>
        {bars.map((bar) => (
          <div key={bar.index} className={bar.full ? 'spbar__seg spbar__seg--full' : 'spbar__seg'}>
            <div className="spbar__fill" style={{ width: `${bar.filled}%` }} />
          </div>
        ))}
        <span className="spbar__value">{sp.toFixed(0)}</span>
      </div>
    </Info>
  );
}

/**
 * What is being dragged onto the track: an operator, and the slot it came
 * from if it is already in the team (reordering) or `null` (from the roster).
 */
export interface OperatorDrag {
  operator: string;
  fromSlot: number | null;
}

export const DRAG_TYPE = 'application/x-endfield-operator';

export function startOperatorDrag(event: React.DragEvent, drag: OperatorDrag): void {
  event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(drag));
  event.dataTransfer.effectAllowed = 'move';
}

function readOperatorDrag(event: React.DragEvent): OperatorDrag | null {
  const raw = event.dataTransfer.getData(DRAG_TYPE);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as OperatorDrag;
  } catch {
    return null;
  }
}

const carriesOperator = (event: React.DragEvent): boolean =>
  event.dataTransfer.types.includes(DRAG_TYPE);

/** Slots in a squad. */
const SLOTS = 4;

/** How close to the edge the scrubbing pointer has to get to scroll the track. */
const EDGE = 40;

/**
 * The drawing half of the track: ruler, ribbon, counters, lanes, playhead.
 *
 * Split out of the screen so browsing a rotation file and editing a draft
 * show the *same* picture. Two renderers would drift, and the editor would
 * start claiming windows the browser does not.
 *
 * `onSelectStep` picks a step by clicking its block. Blocks are deliberately
 * **not** draggable along time — where a step lands is derived from
 * cooldowns and SP, and letting someone drag it elsewhere would be offering
 * them a lie. What *can* be dragged is people: operators onto slots, and slots
 * onto each other, because team position is real input the game reads.
 *
 * Scrubbing captures the pointer, so the playhead follows even outside the
 * track and nothing underneath gets text-selected on the way.
 */
export function TrackCanvas({
  bundle,
  view,
  cursor,
  setCursor,
  zoom,
  selected,
  onSelectStep,
  onPlace,
  onGhost,
  onControl,
  controlChosen,
  damage,
}: {
  bundle: Bundle;
  view: TrackView;
  cursor: number;
  setCursor: (t: number) => void;
  zoom: number;
  /** Step index (1-based), if the editor has one picked. */
  selected?: number | null | undefined;
  onSelectStep?: ((index: number) => void) | undefined;
  /** Dropping an operator on slot `slot` (1-based). Absent: the track takes no drops. */
  onPlace?: ((drag: OperatorDrag, slot: number) => void) | undefined;
  /** Clicking a ghost: insert that CS or FS after `after` steps. */
  onGhost?: ((key: string, after: number, kind: 'CS' | 'FS') => void) | undefined;
  /** Picking who is controlled at the start; `null` — let the track pick. Absent: read-only. */
  onControl?: ((key: string | null) => void) | undefined;
  /** The rotation names who starts controlled, rather than the track picking. */
  controlChosen?: boolean | undefined;
  damage?: TrackDamage | null | undefined;
}): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrubbing, setScrubbing] = useState(false);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const t = useT().canvas;
  const n = useNames();
  const scale = BASE_SCALE * zoom;
  const width = LANE_HEAD + Math.max(view.length * scale + 60, 400);
  // Buffs under the playhead: the step it stands on, minus what ran out
  // before the playhead got there.
  const here = frameAt(view.frames, cursor);
  const markers = (here && damage ? (damage.markers[view.frames.indexOf(here)] ?? []) : []).filter(
    (marker) => marker.until == null || marker.until > cursor + 1e-9,
  );
  // The corner is as tall as the most buffs any step stands under, so
  // scrubbing does not resize the track under the pointer.
  const buffsHeight = useMemo(
    () => Math.max(0, ...(damage?.markers ?? []).map(buffColumnHeight)),
    [damage],
  );
  const ribbonHeight = Math.max(view.spans.length * 17, buffsHeight);

  const seek = (clientX: number): void => {
    const box = scrollRef.current?.getBoundingClientRect();
    const scroller = scrollRef.current;
    if (!box || !scroller) return;
    if (clientX > box.right - EDGE) scroller.scrollLeft += 14;
    else if (clientX < box.left + LANE_HEAD + EDGE && scroller.scrollLeft > 0) scroller.scrollLeft -= 14;
    const x = clientX - box.left + scroller.scrollLeft - LANE_HEAD;
    setCursor(Math.max(0, Math.min(view.length, x / scale)));
  };

  const startScrub = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    // Blocks select their step on click, and lane heads are dragged as
    // operators; capturing the pointer there would swallow both.
    if (target.closest('.act, .lane__head, .stackrow__label')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setScrubbing(true);
    seek(event.clientX);
  };

  const starts = view.frames.map((frame) => frame.world);
  const step = (direction: 1 | -1, fine: boolean): void => {
    if (fine) {
      setCursor(Math.max(0, Math.min(view.length, cursor + direction * 0.1)));
      return;
    }
    const next =
      direction > 0
        ? starts.find((t) => t > cursor + 1e-6)
        : [...starts].reverse().find((t) => t < cursor - 1e-6);
    setCursor(next ?? (direction > 0 ? view.length : 0));
  };

  // Ticks every 5 s, or every second when zoomed in far enough to read them.
  const tickStep = scale > 60 ? 1 : 5;
  const ticks: number[] = [];
  for (let t = 0; t <= view.length; t += tickStep) ticks.push(t);

  const dropProps = (slot: number) =>
    onPlace
      ? {
          onDragOver: (event: React.DragEvent) => {
            if (!carriesOperator(event)) return;
            event.preventDefault();
            event.stopPropagation();
            setDropSlot(slot);
          },
          onDragLeave: () => setDropSlot((current) => (current === slot ? null : current)),
          onDrop: (event: React.DragEvent) => {
            const drag = readOperatorDrag(event);
            setDropSlot(null);
            if (!drag) return;
            event.preventDefault();
            event.stopPropagation();
            onPlace(drag, slot);
          },
        }
      : {};

  // Slots are fixed: an empty one stays where it is, between the lanes.
  const bySlot = new Map(view.lanes.map((lane) => [lane.slot, lane]));
  const slots = onPlace
    ? Array.from({ length: Math.max(SLOTS, ...view.lanes.map((lane) => lane.slot)) }, (_, i) => i + 1)
    : view.lanes.map((lane) => lane.slot);
  const firstEmpty = slots.find((slot) => !bySlot.has(slot));

  return (
    <div
      className={`track__scroll${scrubbing ? ' track__scroll--scrub' : ''}`}
      ref={scrollRef}
      tabIndex={0}
      aria-label={t.trackLabel}
      onKeyDown={(event) => {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          step(event.key === 'ArrowRight' ? 1 : -1, event.shiftKey);
        } else if (event.key === 'Home') setCursor(0);
        else if (event.key === 'End') setCursor(view.length);
      }}
    >
      <div
        className="track__inner"
        style={{ width }}
        onPointerDown={startScrub}
        onPointerMove={(event) => {
          if (scrubbing) seek(event.clientX);
        }}
        onPointerUp={() => setScrubbing(false)}
        onPointerCancel={() => setScrubbing(false)}
        {...(firstEmpty != null ? dropProps(firstEmpty) : {})}
      >
        <div className="track__ruler" title={t.rulerTitle}>
          {ticks.map((t) => (
            <span key={t} className="tick" style={{ left: LANE_HEAD + t * scale }}>
              {t}s
            </span>
          ))}
        </div>

        {/* Ribbon: windows the engine produced, nothing else. */}
        <div className="ribbon" style={{ minHeight: ribbonHeight }}>
          {damage && <BuffColumn markers={markers} height={ribbonHeight} />}
          {view.spans.map((span, index) => (
            <Info key={`${span.term}-${index}`} content={explainTerm(bundle, span.term)}>
              <div
                className={span.to == null ? 'span span--open' : 'span'}
                style={{
                  left: LANE_HEAD + span.from * scale,
                  width: Math.max(((span.to ?? view.length) - span.from) * scale, 24),
                  top: index * 17,
                }}
              >
                {n.term(span.term)}
                {span.level != null && <span className="span__level"> {ROMAN[span.level] ?? span.level}</span>}
                {span.to == null && <em className="span__mark"> ?</em>}
              </div>
            </Info>
          ))}
        </div>

        {/* Stack counters: these are spent, not timed, so not spans. */}
        <div className="stacks" style={{ marginTop: 6 }}>
          {view.stacks.map((series) => (
            <StackRow
              key={series.label}
              series={series}
              scale={scale}
              left={LANE_HEAD}
              length={view.length}
              info={explainTerm(
                bundle,
                series.kind === 'vulnerable' ? 'Vulnerable' : series.label,
                series.kind === 'vulnerable' ? t.vulnerableCounter : t.inflictionCounter,
              )}
            />
          ))}
        </div>

        <div className="lanes">
          {slots.map((slot) => {
            const lane = bySlot.get(slot);
            if (!lane) {
              return (
                <div className={`lane lane--empty${dropSlot === slot ? ' lane--drop' : ''}`} key={`empty-${slot}`} {...dropProps(slot)}>
                  <div className="lane__head">
                    <span className="lane__slot">{String(slot).padStart(2, '0')}</span>
                    <span className="muted">{t.dropHere}</span>
                  </div>
                </div>
              );
            }
            const energy = here?.energy[lane.key] ?? lane.startEnergy;
            const charge = lane.ultCost > 0 ? Math.min(1, energy / lane.ultCost) : 0;
            // The combo's cooldown at the playhead: from its last cast to when it is back.
            const cast = lane.frames.filter(
              (frame) => frame.step.kind === 'CS' && !(frame.step.sequence != null && frame.step.sequence > 1) && frame.world <= cursor + 1e-9,
            ).at(-1);
            const back = here?.cooldowns[`${lane.key}:Combo Skill`] ?? 0;
            const total = cast ? back - cast.world : 0;
            const left = Math.max(0, back - cursor);
            const ready = total > 0 ? 1 - Math.min(1, left / total) : 1;
            return (
            <div
              className={`lane${dropSlot === lane.slot ? ' lane--drop' : ''}`}
              key={lane.key}
              {...dropProps(lane.slot)}
            >
              <div
                className={`lane__head${onPlace ? ' lane__head--drag' : ''}`}
                draggable={Boolean(onPlace)}
                onDragStart={(event) => startOperatorDrag(event, { operator: lane.key, fromSlot: lane.slot })}
                title={onPlace ? t.positionDrag(lane.slot) : t.position(lane.slot)}
              >
                <span className="lane__slot">{String(lane.slot).padStart(2, '0')}</span>
                {lane.icon && <img src={iconUrl(lane.icon)} alt="" width={22} height={22} draggable={false} />}
                <span
                  className="lane__name"
                  style={{ color: ELEMENT_COLOR[lane.element] ?? '#888' }}
                  title={n.operator(lane.key, lane.name)}
                >
                  {n.operator(lane.key, lane.name)}
                </span>
                <ControlDot
                  name={n.operator(lane.key, lane.name)}
                  on={view.controlledAtStart === lane.key}
                  chosen={controlChosen ?? false}
                  onPick={onControl ? () => onControl(controlChosen && view.controlledAtStart === lane.key ? null : lane.key) : undefined}
                />
                <span
                  className={`ultbar${charge >= 1 ? ' ultbar--full' : ''}`}
                  title={t.ultCharge(Math.floor(energy), Math.round(lane.ultCost))}
                >
                  <span className="ultbar__fill" style={{ width: `${charge * 100}%` }} />
                </span>
                <span className={`combobar${left <= 0 ? ' combobar--ready' : ''}`} title={t.comboCooldown(left)}>
                  <span className="combobar__fill" style={{ width: `${ready * 100}%` }} />
                </span>
              </div>
              <div className="lane__body">
                {view.control
                  .filter((span) => span.key === lane.key)
                  .map((span) => (
                    <div
                      key={`control-${span.from}`}
                      className="lane__control"
                      style={{ left: LANE_HEAD + span.from * scale, width: (span.to - span.from) * scale }}
                      title={t.controlSpan(n.operator(lane.key, lane.name), span.from, span.to)}
                    />
                  ))}
                {view.ghosts
                  .filter((ghost) => ghost.key === lane.key && ghost.at <= view.length)
                  .map((ghost) => (
                    <Info
                      key={`ghost-${ghost.kind}-${ghost.after}`}
                      content={
                        <InfoBody
                          title={
                            ghost.kind === 'FS'
                              ? t.strikeGhostTitle(n.operator(lane.key, lane.name))
                              : t.ghostTitle(n.operator(lane.key, lane.name))
                          }
                          kind={t.ghostKind}
                        >
                          <p className="infocard__text">
                            {ghost.kind === 'FS'
                              ? t.strikeGhostText(ghost.openedBy.step)
                              : t.ghostText(
                                  t.ghostOpenedBy(
                                    opName(bundle, ghost.openedBy.actor),
                                    ghost.openedBy.action,
                                    ghost.openedBy.step,
                                  ),
                                  ghost.at,
                                )}
                          </p>
                          {onGhost && <p className="infocard__good">{t.ghostClick(ghost.after)}</p>}
                        </InfoBody>
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        onGhost?.(ghost.key, ghost.after, ghost.kind);
                      }}
                    >
                      <div
                        className="act act--ghost"
                        style={{
                          left: LANE_HEAD + ghost.at * scale,
                          width: ghost.seconds != null ? Math.max(ghost.seconds * scale, 22) : 22,
                          borderColor: ELEMENT_COLOR[lane.element] ?? '#888',
                        }}
                      >
                        {ghost.kind}
                      </div>
                    </Info>
                  ))}
                {lane.frames.map((frame) => {
                  const bad = frame.problems.length > 0;
                  const trigger = frame.verdicts.get(`${frame.step.index}:trigger`);
                  const picked = selected === frame.step.index;
                  // The part that holds the buttons or the chain is solid; the
                  // rest — the operator still busy in the background — a pale tail.
                  const solid = Math.max(frame.holds.input, frame.holds.chain);
                  const tail = frame.duration > solid + 1e-6 ? `${((solid / frame.duration) * 100).toFixed(1)}%` : null;
                  const cooldown = frame.verdicts.get(`${frame.step.index}:cooldown`);
                  const waits = cooldown?.code === 'comboOnCooldown' ? cooldown.seconds : 0;
                  return (
                    <Fragment key={frame.step.index}>
                    {stepHitOffsets(bundle, frame).map((offset) => (
                      <i
                        key={`hit-${offset}`}
                        className="act-hit"
                        style={{ left: LANE_HEAD + (frame.world + offset) * scale }}
                      />
                    ))}
                    {waits > 0 && (
                      <div
                        className="act-wait"
                        style={{ left: LANE_HEAD + (frame.world - waits) * scale, width: waits * scale }}
                        title={say(bundle, cooldown!)}
                      />
                    )}
                    <Info
                      key={frame.step.index}
                      content={
                        <>
                          {explainFrame(bundle, frame)}
                          <DamageLines damage={damage?.steps[view.frames.indexOf(frame)]} />
                        </>
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        setCursor(frame.world);
                        onSelectStep?.(frame.step.index);
                      }}
                    >
                      <div
                        className={`act${bad ? ' act--bad' : ''}${picked ? ' act--picked' : ''}${tail ? ' act--tail' : ''}`}
                        style={{
                          left: LANE_HEAD + frame.world * scale,
                          width: Math.max(frame.duration * scale, 18),
                          borderColor: ELEMENT_COLOR[lane.element] ?? '#888',
                          ...(tail ? { ['--solid' as string]: tail } : {}),
                        }}
                      >
                        {frame.step.kind}
                        {frame.step.sequence ?? ''}
                        {openedBy(trigger) && <i className="act__open" />}
                      </div>
                    </Info>
                    </Fragment>
                  );
                })}
              </div>
            </div>
            );
          })}
        </div>

        <div className="playhead" style={{ left: LANE_HEAD + cursor * scale }}>
          <span className="playhead__time">{cursor.toFixed(1)}s</span>
        </div>
      </div>
    </div>
  );
}

/**
 * Who is controlled when the fight starts: one per team, so a radio. In a
 * draft a click picks; a second click on a chosen one hands the pick back
 * to the track.
 */
function ControlDot({
  name,
  on,
  chosen,
  onPick,
}: {
  name: string;
  on: boolean;
  chosen: boolean;
  onPick: (() => void) | undefined;
}): JSX.Element {
  const t = useT().canvas;
  const title = on
    ? [t.controlStart(name, chosen), onPick && chosen ? t.controlReset : null].filter(Boolean).join(' ')
    : t.controlPick(name);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      aria-label={title}
      title={title}
      className={`controldot${on ? ' controldot--on' : ''}${on && !chosen ? ' controldot--auto' : ''}`}
      disabled={!onPick}
      draggable={false}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onPick?.();
      }}
    />
  );
}

const ICON = 24;
const ICONS_PER_ROW = 5;

function buffColumnHeight(markers: BuffMarker[]): number {
  const rows = (side: BuffMarker['side']) =>
    Math.ceil(markers.filter((marker) => marker.side === side).length / ICONS_PER_ROW);
  const groups = (['target', 'team'] as const).filter((side) => rows(side) > 0);
  return groups.reduce((sum, side) => sum + 12 + rows(side) * (ICON + 4), 0);
}

/**
 * Buffs standing under the playhead, in the empty corner left of the ribbon.
 *
 * Icons only, the rest is on hover: what it gives, from whom, to whom and
 * until when. Sticky like the lane heads, so it stays put while the track
 * scrolls sideways.
 */
function BuffColumn({ markers, height }: { markers: BuffMarker[]; height: number }): JSX.Element {
  const t = useT().canvas;
  const group = (side: BuffMarker['side'], label: string) => {
    const items = markers.filter((marker) => marker.side === side);
    if (items.length === 0) return null;
    return (
      <div className="buffs__group">
        <span className="buffs__label">{label}</span>
        <div className="buffs__icons">
          {items.map((marker) => (
            <Info
              key={marker.id}
              content={
                <InfoBody title={marker.name} kind={marker.kind} source={t.buffFrom(marker.source)}>
                  <ul className="infocard__list">
                    {marker.lines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                  <p className="infocard__text">
                    {marker.side === 'target' ? t.buffOnTarget : t.buffOn(marker.receivers.join(', '))}
                    {marker.stacks > 1 ? t.buffStacks(marker.stacks) : ''}
                    {marker.until != null ? t.buffUntil(marker.until) : t.buffWhile}
                  </p>
                </InfoBody>
              }
            >
              <span className={`buff buff--${marker.side}`}>
                {marker.icon ? (
                  <img src={iconUrl(marker.icon)} alt={marker.name} width={ICON} height={ICON} draggable={false} />
                ) : (
                  <span className="buff__letter">{marker.name.slice(0, 2)}</span>
                )}
                {marker.stacks > 1 && <span className="buff__stacks">{marker.stacks}</span>}
              </span>
            </Info>
          ))}
        </div>
      </div>
    );
  };
  return (
    <div className="buffs" style={{ width: LANE_HEAD, height }}>
      {markers.length === 0 ? (
        <span className="buffs__empty">{t.buffsEmpty}</span>
      ) : (
        <>
          {group('target', t.onTarget)}
          {group('team', t.team)}
        </>
      )}
    </div>
  );
}

/** A step's damage, under its skill tooltip. */
function DamageLines({ damage }: { damage: StepDamage | undefined }): JSX.Element | null {
  const tt = useT();
  const t = tt.canvas;
  if (!damage || damage.parts.length === 0) return null;
  return (
    <div className="infocard__damage">
      <b>{Math.round(damage.total).toLocaleString(tt.locale)}</b> {t.expected}
      <ul className="infocard__list">
        {damage.parts.map((part, index) => (
          <li key={index}>
            {part.label}
            {part.stacks ? t.timesStacks(part.stacks) : ''}: {compact(part.damage)}
          </li>
        ))}
      </ul>
      {damage.buffs.length > 0 && (
        <>
          <div className="infocard__sub">{t.withBuffs}</div>
          <ul className="infocard__list">
            {damage.buffs.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Damage over the whole track: total, per second, who dealt it — and what the
 * sum does not include, listed right next to it.
 *
 * Lives in a column beside the track rather than under it, so the track and
 * its totals fit on one screen.
 */
export function DamagePanel({ view, damage, cursor }: { view: TrackView; damage: TrackDamage; cursor: number }): JSX.Element {
  const t = useT().canvas;
  const n = useNames();
  const best = Math.max(1, ...damage.byOperator.map((item) => item.damage));
  const sofar = view.frames.reduce(
    (sum, frame, index) => (frame.world <= cursor + 1e-9 ? sum + (damage.steps[index]?.total ?? 0) : sum),
    0,
  );
  return (
    <section className="panel dmg">
      <h3>{t.damage}</h3>
      <div className="dmg__head">
        <div>
          <b>{compact(damage.total)}</b>
          <span>{t.total}</span>
        </div>
        <div>
          <b>{compact(damage.dps)}</b>
          <span>{t.perSecond}</span>
        </div>
        <div>
          <b>{compact(sofar)}</b>
          <span>{t.by(cursor)}</span>
        </div>
      </div>
      <ul className="dmg__bars">
        {damage.byOperator.map((item) => (
          <li key={item.key}>
            <span className="dmg__name">{n.operator(item.key, item.name)}</span>
            <span className="dmg__bar">
              <i style={{ width: `${(100 * item.damage) / best}%` }} />
            </span>
            <span className="dmg__value">
              {compact(item.damage)} · {damage.total > 0 ? ((100 * item.damage) / damage.total).toFixed(0) : 0}%
            </span>
          </li>
        ))}
      </ul>
      <p className="hint">{t.expectedHint}</p>
      <details className="dmg__missing">
        <summary>{t.notCounted(damage.notCounted.length)}</summary>
        <ul className="warnings">
          {damage.notCounted.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </details>
    </section>
  );
}

/**
 * What the cursor is standing on, and whether the model is healthy.
 *
 * Shared by both screens for the same reason as the canvas: the editor must
 * not get its own, kinder, verdict about a rotation.
 */
export function TrackPanels({ bundle, view, cursor }: { bundle: Bundle; view: TrackView; cursor: number }): JSX.Element {
  const tt = useT();
  const t = tt.canvas;
  const n = useNames();
  const current = frameAt(view.frames, cursor);
  return (
    <div className="track__panels">
      <section className="panel">
        <h3>{t.at(cursor)}</h3>
        {current ? (
          <table className="stats">
            <tbody>
              <tr>
                <td>{tt.common.step}</td>
                <td>
                  {current.step.actor ? opName(bundle, current.step.actor) : current.step.actorRaw} ·{' '}
                  {t.actionLabel[current.step.kind] ?? current.step.kind}
                </td>
              </tr>
              <tr>
                <td>SP</td>
                <td>{Math.floor(current.sp)} / 300</td>
              </tr>
              <tr>
                <td>{n.term('Vulnerable')}</td>
                <td>{current.target.vulnerable} / 4</td>
              </tr>
              <tr>
                <td>{t.stagger}</td>
                <td>
                  {current.target.staggered
                    ? t.staggered
                    : current.target.stagger > 0
                      ? current.target.stagger.toFixed(0)
                      : '—'}
                </td>
              </tr>
              {Object.entries(current.energy).map(([key, value]) => (
                <tr key={key} className="muted">
                  <td>{t.ultEnergy(opName(bundle, key))}</td>
                  <td>{value.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint">{t.nothingYet}</p>
        )}
        {current?.step.note && <p className="hint">{current.step.note}</p>}
      </section>

      <section className="panel">
        <h3>{t.health}</h3>
        {view.problems.length === 0 ? (
          <p className="hint">
            {view.frames.length === 0 ? t.emptyRotation : t.noProblems}
          </p>
        ) : (
          <ul className="warnings">
            {view.problems.slice(0, 8).map((problem, index) => (
              <li key={index}>{t.problem(problem.step, say(bundle, problem.message))}</li>
            ))}
          </ul>
        )}

        <p className="hint">
          {view.fragile.length === 0 ? t.robust : t.fragile(view.fragile.length, view.fragile.join(', '))}
        </p>
        <p className="hint">{t.waited(view.waited, view.length)}</p>
      </section>
    </div>
  );
}
