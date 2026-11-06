/**
 * The track's damage, as the interface shows it.
 *
 * The sum itself is the engine's (`trackDamage` in `@engine/trackDamage`):
 * which hits a step deals, under which buffs, and what the sum leaves out.
 * Here it only gets words — buff descriptions, caveats in the current
 * language — and the buff column's markers, which are a matter of drawing.
 */

import {
  trackDamage as engineTrackDamage,
  type ActiveBuff,
  type Build,
  type Bundle,
  type DamagePart,
} from '@engine/index.js';

import { currentT } from './i18n/index.js';
import { say } from './messages.js';
import { opName } from './i18n/names.js';
import type { TrackView } from './track.js';

export interface StepDamage {
  /** Expected damage: non-crit × (1 + crit rate × crit damage). */
  total: number;
  parts: DamagePart[];
  /** Buffs and target debuffs this step was computed with. */
  buffs: string[];
}

/**
 * One buff on the track's buff column: an effect from one wearer, with
 * everyone it lands on. Built here, drawn by `TrackCanvas`.
 */
export interface BuffMarker {
  id: string;
  name: string;
  icon: string | null;
  /** `target` — a debuff on the enemy; `team` — a buff on operators. */
  side: 'target' | 'team';
  /** talent, potential, weapon, set, status. */
  kind: string;
  source: string;
  receivers: string[];
  stacks: number;
  /** World time the last stack runs out; null — held by a target state. */
  until: number | null;
  /** «Physical DMG +8 %», one per effect line. */
  lines: string[];
}

export interface TrackDamage {
  /** Aligned with `view.frames`. */
  steps: StepDamage[];
  /** What stands during each step, after its own triggers. Aligned with `view.frames`. */
  markers: BuffMarker[][];
  total: number;
  /** Over the whole track length, waiting included. */
  dps: number;
  byOperator: Array<{ key: string; name: string; damage: number }>;
  /** What the numbers leave out. Shown next to them, always. */
  notCounted: string[];
}

export function trackDamage(
  bundle: Bundle,
  view: TrackView,
  buildOf: (key: string) => Build,
  enemyKey: string | null,
): TrackDamage {
  const damage = engineTrackDamage(
    bundle,
    { frames: view.frames, length: view.length, team: view.lanes.map((lane) => lane.key), target: view.target },
    buildOf,
    enemyKey,
  );
  const notes = currentT().notes;
  return {
    steps: damage.steps.map((step) => ({
      total: step.total,
      parts: step.parts,
      buffs: [
        ...new Set(step.buffs.map((buff) => describeBuff(bundle, buff))),
        ...(step.link ? [notes.linkSpent(step.link.count, step.link.bonus)] : []),
      ],
    })),
    markers: damage.standing.map((standing) => toMarkers(bundle, buildOf, standing)),
    total: damage.total,
    dps: damage.dps,
    byOperator: view.lanes.map((lane, index) => ({
      key: lane.key,
      name: lane.name,
      damage: damage.byOperator[index]?.damage ?? 0,
    })),
    notCounted: damage.notCounted.map(({ operator, message }) =>
      operator ? `${opName(bundle, operator)}: ${say(bundle, message)}` : say(bundle, message),
    ),
  };
}

/** 12345 → "12.3k", for tight spaces. */
export function compact(value: number): string {
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
  return value.toFixed(0);
}

/** How a stat reads in a tooltip: «Physical DMG», «ATK», «Arts Intensity». */
const STAT_LABEL: Record<string, string> = {
  atk_pct: 'ATK',
  atk_flat: 'ATK',
  dmg_bonus: 'DMG',
  dmg_taken: 'DMG Taken',
  susceptibility: 'Susceptibility',
  amp: 'Amp',
  arts_intensity: 'Arts Intensity',
  crit_rate: 'Crit Rate',
  crit_dmg: 'Crit DMG',
  hp_pct: 'HP',
  hp_flat: 'HP',
  ult_gain_eff: 'Ultimate Gain',
  stagger_eff: 'Stagger Efficiency',
  treatment: 'Treatment',
  dmg_reduction: 'DMG Reduction',
  res_ignore: 'RES shred',
};

/** "Physical DMG +8 %": the line itself, without names. */
function describeLine(buff: ActiveBuff): string {
  const { apply } = buff;
  const value = apply.value * buff.stacks * buff.scale;
  const amount = apply.unit === 'frac' ? `${(value * 100).toFixed(1).replace(/\.0$/, '')} %` : value.toFixed(0);
  const stat = apply.stat === 'attr' ? (apply.attribute ?? 'attribute') : (STAT_LABEL[apply.stat] ?? apply.stat.replace(/_/g, ' '));
  const what = [apply.element, apply.skillType, stat].filter(Boolean).join(' ');
  return `${what} +${amount}`;
}

/** The picture of a buff: its talent, weapon, a piece of its set, the status, or the skill. */
function buffIcon(bundle: Bundle, buildOf: (key: string) => Build, buff: ActiveBuff): string | null {
  const { effect } = buff;
  const operator = effect.operator ? bundle.operators[effect.operator] : undefined;
  switch (effect.source.kind) {
    case 'talent':
      return operator?.talents.find((talent) => talent.name === effect.source.name)?.icon ?? operator?.icon ?? null;
    case 'potential':
      // Potentials have no icon of their own: the operator's portrait says whose it is.
      return operator?.icon ?? null;
    case 'weapon':
      return effect.item ? (bundle.weapons[effect.item]?.icon ?? null) : null;
    case 'gear-set': {
      // The piece the wearer actually has, so the icon matches the build.
      const worn = buildOf(buff.source)
        .gear.map((slot) => (slot ? bundle.gear.pieces[slot.key] : undefined))
        .find((piece) => piece?.set === effect.item);
      const any = Object.values(bundle.gear.pieces).find((piece) => piece.set === effect.item);
      return worn?.icon ?? any?.icon ?? null;
    }
    case 'status':
      return effect.item ? (bundle.mechanics[effect.item]?.icon ?? null) : null;
    case 'skill':
      return operator?.skills.find((skill) => skill.name === effect.source.name)?.icon ?? operator?.icon ?? null;
    default:
      return null;
  }
}

/** Buffs standing on a step → one marker per effect and wearer. */
function toMarkers(bundle: Bundle, buildOf: (key: string) => Build, standing: ActiveBuff[]): BuffMarker[] {
  const groups = new Map<string, BuffMarker & { seen: Set<string> }>();
  for (const buff of standing) {
    const { effect, apply } = buff;
    const side = buff.receiver === 'enemy' ? 'target' : 'team';
    // One effect can do both: Brigand's Calling buffs its wearer and debuffs the target.
    const id = `${effect.id}|${buff.source}|${side}`;
    let marker = groups.get(id);
    if (!marker) {
      marker = {
        id,
        name: apply.name ?? effect.item ?? effect.source.name,
        icon: buffIcon(bundle, buildOf, buff),
        side,
        kind: currentT().notes.kind[effect.source.kind] ?? effect.source.kind,
        source: opName(bundle, buff.source),
        receivers: [],
        stacks: 0,
        until: buff.until ?? null,
        lines: [],
        seen: new Set(),
      };
      groups.set(id, marker);
    }
    if (buff.receiver !== 'enemy') {
      const name = opName(bundle, buff.receiver);
      if (!marker.receivers.includes(name)) marker.receivers.push(name);
    }
    marker.stacks = Math.max(marker.stacks, buff.stacks);
    if (buff.until != null) marker.until = Math.max(marker.until ?? 0, buff.until);
    // A team share is a fraction of the wearer's own line: show the full one.
    const line = describeLine({ ...buff, scale: Math.max(buff.scale, 1) });
    if (!marker.seen.has(line)) {
      marker.seen.add(line);
      marker.lines.push(line);
    }
    if (buff.scale < 1 && !marker.seen.has('share')) {
      marker.seen.add('share');
      marker.lines.push(currentT().notes.teammatesShare(Math.round(buff.scale * 100)));
    }
  }
  return [...groups.values()].map(({ seen: _seen, ...marker }) => marker);
}

/** "Frontiers +16 % DMG (Camille)" — for the step tooltip. */
function describeBuff(bundle: Bundle, buff: ActiveBuff): string {
  const { effect, apply } = buff;
  const name = apply.name ?? effect.item ?? effect.source.name;
  const value = apply.value * buff.stacks * buff.scale;
  const stacks = buff.stacks > 1 ? ` ×${buff.stacks}` : '';
  const from = opName(bundle, buff.source);
  return `${name}${stacks}: ${describeLine(buff)}${buff.receiver === 'enemy' ? currentT().notes.onTarget : ''} (${from})`;
}
