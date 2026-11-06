/**
 * Status damage on the track.
 *
 * The simulation already knows what happened at each step: which status
 * was applied, how many stacks were consumed, whose element triggered a
 * reaction. Here those events become damage instances, and status debuffs
 * become buffs on the target. There is one formula — `computeDamage`; the
 * base is `STATUS_BASE`.
 *
 * Where things come from:
 *
 * * **Whose damage.** Whoever applied the status or shattered the
 *   Solidification: their ATK, Arts Intensity and bonuses (measurements,
 *   #3 and #25). Combustion ticks belong to whoever's element triggered the
 *   reaction (#5).
 * * **The first hit on a clean target** applies Vulnerable instead of the
 *   Physical Status and deals no damage at all (glossary; #8).
 * * **A forced reaction** ("forcibly apply") has no initial hit and is
 *   level I (wiki, Solidification, Arts Reaction).
 * * **Skill-type bonuses** do not apply to statuses: Crush does not take
 *   Battle Skill DMG (#27.1). Elemental and "all types" bonuses do (#23).
 * * **The Breach and Electrification debuffs** grow with the applier's AI:
 *   `(3·AI + 300)/(AI + 300)` (wiki; #23 — Breach to the point).
 * * **Corrosion** shreds the resistance of all five elements and Physical.
 *   The wiki gives the table (initial shred, step per second, cap), the
 *   client the mechanics: the shred grows in steps once per second
 *   (`triggerInterval 1.0`), a new Corrosion inherits the old one's current
 *   shred if it is larger (`GetTargetBuffBB`), and Arcane's talent
 *   multiplies only the cap.
 */

import type { ActiveBuff } from './buffs.js';
import {
  BREACH_DEBUFF,
  computeDamage,
  statusMultiplier,
  STATUS_BASE,
  type DamageResult,
  type InstanceKind,
} from './damage.js';
import type { Effect } from './effects.js';
import type { Frame } from './simulate.js';
import { dmgBonusFor, type StatSheet } from './stats.js';
import { ARTS_ELEMENTS } from './stats.js';
import { MAX_STACKS } from './status.js';

/** A reaction's damage element is the incoming infliction's element (wiki, Arts Reaction). */
const REACTION_ELEMENT: Record<string, string> = {
  Combustion: 'Heat',
  Electrification: 'Electric',
  Solidification: 'Cryo',
  Corrosion: 'Nature',
};

/** How many seconds Combustion burns (wiki). */
const COMBUSTION_SECONDS = 10;

export interface StatusHit {
  /** «Breach», «Cryo Burst», «Combustion», «Combustion DoT», «Shatter». */
  name: string;
  kind: InstanceKind;
  /** Fraction of ATK per instance; for a DoT, per second. */
  multiplier: number;
  element: string;
  /** Whose damage. */
  by: string;
  statusLevel: number;
  /** DoT: how many ticks fit into the track. */
  ticks?: number;
  /** Per-tick damage against the plain status's, from what applied it (`Debuff.dotScale`); a boosted status (Crush on Sunderization). */
  scale?: number;
  /** The hit ×(1 + this × the owner's Arts Intensity): Sunderization's explosion. */
  aiPerPoint?: number;
}

const level = (consumed: number | undefined): number => Math.min(Math.max(consumed ?? 1, 1), MAX_STACKS);

/**
 * Status damage instances by frame.
 *
 * `end` is the track's world end time: Combustion ticks past it are not
 * counted, or a short rotation's damage per second gets inflated by
 * burning it did not pay for.
 */
export function statusHits(frames: Frame[], end: number): StatusHit[][] {
  const combustions: Array<{ frame: number; at: number }> = [];
  const out = frames.map((frame, index) => {
    const hits: StatusHit[] = [];
    let combusted = false;
    for (const event of frame.status) {
      const by = event.by;
      if (!by) continue;
      switch (event.kind) {
        case 'buildsVulnerable':
          if (!event.appliedVulnerableInstead && STATUS_BASE[event.term]) {
            hits.push({ name: event.term, kind: 'physicalStatus', multiplier: statusMultiplier(event.term)!, element: 'Physical', by, statusLevel: 0 });
          }
          break;
        case 'consumesVulnerable':
          if ((event.term === 'Crush' || event.term === 'Breach') && (event.consumed ?? 0) > 0) {
            const sl = level(event.consumed);
            hits.push({
              name: event.term,
              kind: 'physicalStatus',
              multiplier: statusMultiplier(event.term, sl)!,
              element: 'Physical',
              by,
              statusLevel: sl,
              ...(event.boost != null ? { scale: event.boost } : {}),
            });
          }
          break;
        case 'markDetonated':
          // Argent Flow's Sunderization: a plain hit by his ATK — no hidden
          // level multiplier, no AI scaling of a status — plus a bonus per
          // point of his AI (measurements, #59).
          if (event.multiplier) {
            hits.push({
              name: event.term,
              kind: 'skill',
              multiplier: event.multiplier,
              element: event.blastElement ?? 'Electric',
              by,
              statusLevel: event.consumed ?? 0,
              ...(event.aiPerPoint ? { aiPerPoint: event.aiPerPoint } : {}),
            });
          }
          break;
        case 'infliction':
          if (event.burst && event.element) {
            hits.push({ name: `${event.element} Burst`, kind: 'artsBurst', multiplier: statusMultiplier('Arts Burst')!, element: event.element, by, statusLevel: 0 });
          }
          break;
        case 'consumesInfliction': {
          const element = REACTION_ELEMENT[event.term];
          if (!element || (event.consumed ?? 0) === 0) break;
          const sl = level(event.consumed);
          hits.push({ name: event.term, kind: 'artsReaction', multiplier: statusMultiplier('Arts Reaction', sl)!, element, by, statusLevel: sl });
          if (event.term === 'Combustion') combusted = true;
          break;
        }
        case 'other':
          if (event.term === 'Shatter') {
            const sl = level(event.consumed);
            hits.push({ name: 'Shatter', kind: 'shatter', multiplier: statusMultiplier('Shatter', sl)!, element: 'Physical', by, statusLevel: sl });
          } else if (event.term === 'Combustion' && event.forced) {
            combusted = true;
          }
          break;
        default:
          break;
      }
    }
    if (combusted) combustions.push({ frame: index, at: frame.world });
    return hits;
  });

  // Combustion ticks: from application to the end of the burn, a new Combustion, or the track.
  combustions.forEach((item, position) => {
    const frame = frames[item.frame]!;
    const debuff = frame.target.debuffs.find((entry) => entry.term === 'Combustion');
    if (!debuff) return;
    const next = combustions[position + 1]?.at ?? Infinity;
    // A temporary Combustion (Laevatain's forced one, 5 s) stops at its own end.
    const last = debuff.expiresAt ?? item.at + COMBUSTION_SECONDS;
    const stop = Math.min(last, next, end);
    const ticks = Math.max(0, Math.floor(stop - item.at + 1e-9));
    if (ticks === 0) return;
    const sl = level(debuff.level);
    out[item.frame]!.push({
      name: 'Combustion DoT',
      kind: 'dot',
      multiplier: statusMultiplier('Combustion', sl)!,
      element: 'Heat',
      by: debuff.source,
      statusLevel: sl,
      ticks,
      ...(debuff.dotScale != null ? { scale: debuff.dotScale } : {}),
    });
  });
  return out;
}

/** `(3·AI + 300)/(AI + 300)` — amplification of reaction and Breach debuffs (wiki). */
export function debuffIntensity(artsIntensity: number): number {
  return (3 * artsIntensity + 300) / (artsIntensity + 300);
}

/** Who applied the debuff: its strength depends on them. */
export interface Applier {
  artsIntensity: number;
  /** Bonus to the reaction's shred cap: Arcane's Weapon Honing and P3. */
  reactionMax?: Record<string, number>;
}

/**
 * Corrosion's resistance shred as a fraction, `seconds` after application.
 *
 * The wiki's table by Status Level: initial 3.6 + 1.2·(SL − 1), step
 * 0.84 + 0.28·(SL − 1) per second, cap 12 + 4·(SL − 1); all ×
 * `(3·AI + 300)/(AI + 300)`. Exactly 10 steps to the cap at any level. The
 * talent multiplies only the cap, so with it there are more steps.
 * `inherited` is the previous Corrosion's shred at the moment of
 * application: if it is above the new cap, it stays and stops growing
 * (wiki).
 */
export function corrosionShred(
  level: number,
  artsIntensity: number,
  seconds: number,
  maxBonus = 0,
  inherited = 0,
): number {
  const sl = Math.min(Math.max(level, 1), MAX_STACKS);
  const k = debuffIntensity(artsIntensity);
  const start = (2.4 + 1.2 * sl) * k;
  const step = (0.56 + 0.28 * sl) * k;
  const max = (8 + 4 * sl) * k * (1 + maxBonus);
  if (inherited >= max) return inherited / 100;
  const base = Math.max(start, inherited);
  return Math.min(max, base + step * Math.floor(seconds + 1e-9)) / 100;
}

function statusEffect(
  term: string,
  sl: number,
  element: string | undefined,
  value: number,
  stat: 'dmg_taken' | 'res_ignore' = 'dmg_taken',
): Effect {
  return {
    id: `status.${term.toLowerCase()}`,
    operator: null,
    item: term,
    source: { kind: 'status', name: term, condition: `SL ${sl}` },
    group: `status.${term.toLowerCase()}`,
    groupMode: 'highest',
    tier: sl,
    requires: {},
    text: null,
    seen: null,
    stale: false,
    apply: [{ stat, unit: 'frac', value, rawValue: value * 100, target: 'enemy', trigger: null, ...(element ? { element } : {}) }],
    confidence: 'confirmed',
  };
}

export type TargetDebuff = Frame['target']['debuffs'][number];

/**
 * Status debuffs on the target: `before` — standing at the start of the
 * step, `fresh` — applied by this step. The same cast's second sequence
 * already gets them: Pogranichnik's SEQ 2 hits on its own Breach, the
 * Breach itself does not (#23).
 *
 * `applierOf` gets the debuff itself, so a caller can answer with the
 * applier as they stood when it was applied (`trackDamage` does).
 */
export function statusDebuffs(
  frames: Frame[],
  applierOf: (debuff: TargetDebuff) => Applier,
): { before: ActiveBuff[][]; fresh: ActiveBuff[][] } {
  type Debuff = TargetDebuff;
  // Corrosion remembers what it inherited: in application order, the
  // previous one's shred at the moment of the new one.
  const inherited = new Map<number, number>();
  let last: Debuff | null = null;
  const shredAt = (debuff: Debuff, t: number): number => {
    const applier = applierOf(debuff);
    return corrosionShred(
      debuff.level ?? 1,
      applier.artsIntensity,
      t - debuff.appliedAt,
      applier.reactionMax?.Corrosion ?? 0,
      inherited.get(debuff.appliedAt) ?? 0,
    );
  };
  for (const frame of frames) {
    const corrosion = frame.target.debuffs.find((debuff) => debuff.term === 'Corrosion');
    if (!corrosion || inherited.has(corrosion.appliedAt)) continue;
    const alive = last && (last.expiresAt == null || last.expiresAt > corrosion.appliedAt + 1e-9);
    inherited.set(corrosion.appliedAt, alive ? shredAt(last!, corrosion.appliedAt) * 100 : 0);
    last = corrosion;
  }

  const toBuff = (debuff: Debuff, now: number): ActiveBuff | null => {
    const sl = level(debuff.level);
    const scale = debuffIntensity(applierOf(debuff).artsIntensity);
    let effect: Effect | null = null;
    if (debuff.term === 'Breach') effect = statusEffect('Breach', sl, 'Physical', (BREACH_DEBUFF[sl]?.dmgTaken ?? 0) * scale);
    // Argent Flow's Electrification raises every DMG type, not only Arts (#59).
    if (debuff.term === 'Electrification') effect = statusEffect('Electrification', sl, debuff.allTypes ? undefined : 'Arts', (0.08 + 0.04 * sl) * scale);
    if (debuff.term === 'Corrosion') effect = statusEffect('Corrosion', sl, undefined, shredAt(debuff, now), 'res_ignore');
    if (!effect) return null;
    return {
      effect,
      apply: effect.apply[0]!,
      source: debuff.source,
      receiver: 'enemy',
      stacks: 1,
      scale: 1,
      ...(debuff.expiresAt != null ? { until: debuff.expiresAt } : {}),
    };
  };

  const before: ActiveBuff[][] = [];
  const fresh: ActiveBuff[][] = [];
  frames.forEach((frame, index) => {
    const previous = index > 0 ? frames[index - 1]!.target.debuffs : [];
    before.push(
      previous
        .filter((debuff) => debuff.expiresAt == null || debuff.expiresAt > frame.world + 1e-9)
        .map((debuff) => toBuff(debuff, frame.world))
        .filter((buff): buff is ActiveBuff => buff !== null),
    );
    fresh.push(
      frame.target.debuffs
        .filter((debuff) => Math.abs(debuff.appliedAt - frame.world) < 1e-9)
        .map((debuff) => toBuff(debuff, frame.world))
        .filter((buff): buff is ActiveBuff => buff !== null),
    );
  });
  return { before, fresh };
}

export interface StatusContext {
  sheet: StatSheet;
  /** Target groups: DMG Taken, Susceptibility and resistance shred by element. */
  target: { dmgTaken: Record<string, number>; susceptibility: Record<string, number>; resShred?: Record<string, number> };
  /** Σ Amp by element (`AssumedContribution.self`). */
  amp: Record<string, number>;
  operatorLevel: number;
  def: number;
  resistance: number;
  staggered: boolean;
}

/**
 * Expected damage of one status instance: non-crit × (1 + crit rate ×
 * crit damage); a DoT has no crit, all ticks at once.
 */
export function statusDamage(hit: StatusHit, ctx: StatusContext): DamageResult & { expected: number } {
  const { sheet } = ctx;
  // Skill-type bonuses do not apply to statuses (#27.1), nor does "all skills"
  // (`dmgBonusFor` adds it only with a skill type).
  const dmgBonus = dmgBonusFor(sheet, { element: hit.element, staggered: ctx.staggered });
  const pick = (groups: Record<string, number>): number =>
    (groups[hit.element] ?? 0) + (ARTS_ELEMENTS.has(hit.element) ? (groups.Arts ?? 0) : 0) + (groups.all ?? 0);
  const result = computeDamage({
    attack: sheet.attack,
    baseMultiplier: hit.multiplier * (hit.ticks ?? 1) * (hit.scale ?? 1),
    kind: hit.kind,
    dmgBonus,
    amp: pick(ctx.amp),
    staggered: ctx.staggered,
    increasedDmgTaken: pick(ctx.target.dmgTaken),
    susceptibility: pick(ctx.target.susceptibility),
    def: ctx.def,
    resistance: ctx.resistance,
    corrosionShred: pick(ctx.target.resShred ?? {}),
    operatorLevel: ctx.operatorLevel,
    artsIntensity: sheet.artsIntensity,
  });
  const crit = hit.kind === 'dot' ? 1 : 1 + Math.min(1, Math.max(0, sheet.critRate)) * sheet.critDmg;
  return { ...result, expected: result.damage * crit };
}
