/**
 * Susceptibility and Amp a skill puts up itself (`Skill.grants`), as buffs
 * on the track.
 *
 * The simulation already holds them on the target: who applied the term,
 * with which skill, until when. What the term is worth was decided once in
 * `export.py` — which rows hold the value, what it scales with — and here
 * it is read at the applier's skill level:
 *
 * * **Susceptibility** sits on the enemy and raises the damage of its
 *   element (`Arts` — of every arts element). **Amp** reaches every squad
 *   member: «grants Cryo Amp and Heat Amp to the entire team».
 * * **Effects of the same type stack** (glossary): two Physical
 *   Susceptibilities from two skills add up. One term from one skill does
 *   not: the simulation replaces it.
 * * **The value is fixed when the skill applies it**: Liino's Will, Xaihi's
 *   Intellect, the Vulnerable stacks under Gilberta's field — as they stood
 *   at that step (measurements, #50).
 * * **The same timing as the status debuffs**: a step does not get what it
 *   applied itself; a later move of the same cast does (#23).
 * * **Potentials edit the skill's value** (`Effect.grants`): Xaihi's P5
 *   multiplies her ultimate's Amp by 1.1, Lifeng's P1 adds 5 %.
 */

import type { ActiveBuff } from './buffs.js';
import type { AttributeKey, Bundle, Skill, SkillGrant, SkillType } from './bundle.js';
import { grantModifiers, type Effect, type GrantModifier } from './effects.js';
import { statAt, type Frame } from './simulate.js';

/** The applier as their skills see them: skill levels, attributes, what their potentials change. */
export interface Granter {
  skills: Record<SkillType, number>;
  attributes: Partial<Record<AttributeKey, number>>;
  /** `Effect.grants` of the applier's enabled effects. */
  mods?: GrantModifier[];
}

type TargetDebuff = Frame['target']['debuffs'][number];

/**
 * A grant's value at the applier's level: the plain rows; the row for what
 * the cast made; an attribute part up to its cap; a part per Vulnerable
 * stack.
 */
export function grantValue(
  skill: Skill,
  grant: SkillGrant,
  level: number,
  ctx: { made: number | null; vulnerable: number; attributes: Partial<Record<AttributeKey, number>> },
): number {
  let value = 0;
  for (const part of grant.rows) {
    const row = statAt(skill, part.row, level) ?? 0;
    if (part.made != null) {
      if (part.made === ctx.made) value += row;
    } else if (part.per === 'Vulnerable') {
      value += row * ctx.vulnerable;
    } else if (part.per) {
      const attribute = ctx.attributes[part.per] ?? 0;
      if (part.at) {
        // «Max Bonus Susceptibility from Will» at «Will for MAX Bonus Susceptibility»: linear up to it.
        const at = statAt(skill, part.at, level) ?? 0;
        value += at > 0 ? row * Math.min(1, attribute / at) : 0;
      } else {
        const cap = part.max ? statAt(skill, part.max, level) : null;
        value += cap != null ? Math.min(cap, row * attribute) : row * attribute;
      }
    } else {
      value += row;
    }
  }
  return value;
}

function grantEffect(operator: string, skill: Skill, grant: SkillGrant, value: number): Effect {
  return {
    id: `grant.${operator}.${skill.name}.${grant.term}`,
    operator,
    item: skill.name,
    source: { kind: 'skill', name: skill.name, condition: grant.term },
    group: `grant.${operator}.${grant.term}`,
    groupMode: 'highest',
    tier: 1,
    requires: {},
    text: null,
    seen: null,
    stale: false,
    apply: [
      {
        stat: grant.stat,
        unit: 'frac',
        value,
        rawValue: value * 100,
        target: grant.target === 'enemy' ? 'enemy' : grant.target === 'controlled' ? 'self' : 'team',
        trigger: null,
        element: grant.element,
        name: grant.term,
      },
    ],
    confidence: 'inferred',
  };
}

export interface GrantTimeline {
  /** Standing at the start of the step. Aligned with the frames. */
  before: ActiveBuff[][];
  /** Applied by this step: a later move of the same cast gets them. */
  fresh: ActiveBuff[][];
  /** Applied, but left out of the numbers: a roll, or one operator on a condition. */
  uncounted: Array<{ operator: string; term: string; reason: 'chance' | 'single' }>;
  /** Whether some value depends on the applier's attributes or the target's stacks. */
  scaled: boolean;
}

/** One application of a debuff: the same term from the same source at the same time. */
const instanceId = (debuff: TargetDebuff): string => `${debuff.term}|${debuff.source}|${debuff.appliedAt}`;

/** Grants on the target and the team, by frame. `granterOf` — the applier's build; `null` — not in the squad. */
export function grantBuffs(
  bundle: Bundle,
  frames: Frame[],
  team: string[],
  granterOf: (key: string) => Granter | null,
): GrantTimeline {
  const uncounted: GrantTimeline['uncounted'] = [];
  let scaled = false;
  /** Each instance is valued once, at the step that applied it. */
  const valued = new Map<string, ActiveBuff[] | null>();

  const buffsOf = (debuff: TargetDebuff, index: number): ActiveBuff[] | null => {
    const id = instanceId(debuff);
    if (valued.has(id)) return valued.get(id)!;
    const skill = debuff.skill ? bundle.operators[debuff.source]?.skills.find((item) => item.name === debuff.skill) : undefined;
    const grant = skill?.grants?.find((item) => item.term === debuff.term);
    const granter = grant ? granterOf(debuff.source) : null;
    let out: ActiveBuff[] | null = null;
    if (skill && grant && granter) {
      if (grant.uncounted) {
        if (!uncounted.some((row) => row.operator === debuff.source && row.term === grant.term)) {
          uncounted.push({ operator: debuff.source, term: grant.term, reason: grant.uncounted });
        }
      } else {
        if (grant.rows.some((row) => row.per) || grant.on) scaled = true;
        const base = grantValue(skill, grant, granter.skills[skill.type] ?? 1, {
          made: debuff.level ?? null,
          // Under the field as the cast landed: the frame before it.
          vulnerable: index > 0 ? frames[index - 1]!.target.vulnerable : 0,
          attributes: granter.attributes,
        });
        const mods = grantModifiers(granter.mods ?? [], skill, grant.term);
        const value = mods.reduce((sum, mod) => sum * (mod.multiplier ?? 1), base) + mods.reduce((sum, mod) => sum + (mod.add ?? 0), 0);
        const effect = grantEffect(debuff.source, skill, grant, value);
        // Xaihi's crystal: the one who struck.
        const receivers = grant.target === 'enemy' ? ['enemy'] : debuff.receiver ? [debuff.receiver] : team;
        out = receivers.map((receiver) => ({
          effect,
          apply: effect.apply[0]!,
          source: debuff.source,
          receiver,
          stacks: 1,
          scale: 1,
          ...(debuff.expiresAt != null ? { until: debuff.expiresAt } : {}),
        }));
      }
    }
    valued.set(id, out);
    return out;
  };

  // The frame an instance first shows up in is the step that applied it.
  // Its `appliedAt` is not that step's press: a hit in flight lands between
  // presses and stamps the debuff with the hit's time (`landInFlight`).
  const appliedIn = new Map<string, number>();
  frames.forEach((frame, index) => {
    for (const debuff of frame.target.debuffs) {
      const id = instanceId(debuff);
      if (!appliedIn.has(id)) appliedIn.set(id, index);
    }
  });
  const valueOf = (debuff: TargetDebuff): ActiveBuff[] => {
    const index = appliedIn.get(instanceId(debuff));
    return index == null ? [] : (buffsOf(debuff, index) ?? []);
  };

  const before: ActiveBuff[][] = [];
  const fresh: ActiveBuff[][] = [];
  frames.forEach((frame, index) => {
    const previous = index > 0 ? frames[index - 1]!.target.debuffs : [];
    before.push(
      previous.filter((debuff) => debuff.expiresAt == null || debuff.expiresAt > frame.world + 1e-9).flatMap(valueOf),
    );
    fresh.push(frame.target.debuffs.filter((debuff) => appliedIn.get(instanceId(debuff)) === index).flatMap(valueOf));
  });
  return { before, fresh, uncounted, scaled };
}
