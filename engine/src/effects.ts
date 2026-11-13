/**
 * The effects layer: talents, potentials and other text placed into the
 * formula's groups (format: `data/endfield/effects/README.md`).
 *
 * Text parsing does NOT live here. It is done by hand in
 * `data/endfield/effects/*.yaml` and checked for drift against the wiki in
 * `tools/ef/effects.py`; the engine receives ready records with an explicit
 * unit on every number. The reason is the same as for having no second
 * damage formula: two readings of one text drift apart on the first patch.
 *
 * The module decides only four things itself, all mechanical:
 *
 * 1. **which records are enabled** at a given elite and potential, with
 *    this weapon and these sets;
 * 2. **which of a weapon's nine values applies** — by the column `export.py`
 *    computed from the essence (measurements, #6). No column — the row is
 *    not applied and goes into "not modelled";
 * 3. **how the tiers of one talent combine** — max or sum, per the
 *    `groupMode` flag in the data;
 * 4. **two passes for attribute-based effects.** Lifeng's `Illumination`
 *    grants ATK per point of INT and WIL, so the stat sheet is computed
 *    twice: once to learn the attributes, then again with their bonus. The
 *    attributes are already final in the first pass: talents' flat bonuses
 *    are in it, and percent ATK does not affect attributes.
 */

import type { AttributeKey, Operator, SkillType, Unit } from './bundle.js';
import {
  ARTS_ELEMENTS,
  ATTRIBUTE_KEY,
  buildStats,
  type BuildInput,
  type DmgBonusBuckets,
  type ExtraStats,
  type StatSheet,
} from './stats.js';

export type EffectStat =
  | 'attr'
  | 'atk_pct'
  | 'atk_attr_factor'
  | 'atk_flat'
  | 'hp_pct'
  | 'hp_flat'
  | 'attr_pct'
  | 'dmg_reduction'
  | 'treatment'
  | 'crit_rate'
  | 'crit_dmg'
  | 'dmg_bonus'
  | 'arts_intensity'
  | 'amp'
  | 'susceptibility'
  | 'dmg_taken'
  | 'weaken'
  | 'protect'
  | 'def_shred'
  | 'res_ignore'
  | 'base_multiplier'
  | 'skill_multiplier'
  | 'stagger_flat'
  | 'stagger_eff'
  | 'ult_gain_eff'
  | 'sp_return'
  | 'sp_return_mult'
  | 'sp_cost'
  | 'cooldown_flat'
  | 'cooldown_pct'
  | 'ult_cost_pct'
  | 'reaction_duration'
  | 'reaction_max'
  | 'reaction_duration_mult'
  | 'reaction_dot_mult'
  | 'extra_hit';

export interface EffectApply {
  stat: EffectStat;
  unit: Unit;
  /** Converted to fractions where the stat is a percentage. */
  value: number;
  /** As in the game text — shown next to the number. */
  rawValue: number;
  /** `others` — the team minus the wearer ("other teammates gain…"). */
  /**
   * `spender` — whoever's step set the trigger off, with stacks of their own:
   * Pogranichnik's Tactical Instruction gives Fervent Morale to the operator
   * whose step spent a Steel Oath point (`charge_spent`).
   */
  target: 'self' | 'team' | 'others' | 'enemy' | 'spender';
  /** `null` — the effect is permanent and goes into the stat sheet. `|` — any of. */
  trigger: string | null;
  attribute?: AttributeKey;
  /**
   * Value per point of the listed attributes. For `atk_attr_factor` —
   * which attributes get a bonus to their AttributeBonus coefficient.
   */
  perAttribute?: AttributeKey[];
  element?: string;
  skillType?: SkillType;
  skill?: string;
  /** The reaction the row modifies: `reaction_duration`, `reaction_max`. */
  reaction?: string;
  /** The buff's in-game name, if it has its own: "Fervent Morale". */
  name?: string;
  staggered?: boolean;
  /** Any of the terms on the target enables the effect. */
  targetHas?: string[];
  /**
   * `from: consumed` — as many stacks as the step consumed: "+6 % × Vulnerable
   * stacks"; `accumulate` — casts add up to `max` instead of replacing.
   */
  stacks?: { max: number; perTrigger: number; from?: 'consumed'; accumulate?: boolean };
  /** The buff is spent by the wearer's cast: "next battle skill", `cast:Battle Skill|cast:Ultimate`. */
  spentBy?: string;
  /**
   * Fires only while the wearer is the controlled operator: "If the wielder
   * is also the controlled operator, double the ATK increase" (Sundered
   * Prince). The build editor assumes it is.
   */
  controlled?: boolean;
  duration?: number;
  /** Seconds before the row may fire again (`extra_hit`: «Effect trigger cooldown»). */
  cooldown?: number;
  /** `extra_hit`'s own Stagger, before the wearer's Stagger Efficiency: Swordmancer's «[10 Stagger]». */
  stagger?: number;
  durationDelta?: number;
  teamShare?: number;
}

/**
 * A row as stored in the bundle. Weapons have a table by column (`values`)
 * instead of a number, and `value` is `null` there until the engine picks a
 * column; `activeEffects` hands out `EffectApply` already resolved.
 */
export interface EffectApplyEntry extends Omit<EffectApply, 'value' | 'rawValue' | 'attribute'> {
  value: number | null;
  rawValue: number | null;
  values?: number[];
  rawValues?: number[];
  /** `MAIN` / `SUB` — the operator's attribute, not the item's. */
  attribute?: AttributeKey | 'MAIN' | 'SUB';
}

export interface Effect {
  id: string;
  /** `null` for weapons and sets: their owner is an item, `item`. */
  operator: string | null;
  /** Weapon or set name. */
  item?: string | null;
  /** The weapon component whose column the values follow. */
  component?: string;
  /**
   * `status` — a status debuff on the target (Breach, Electrification), not from the layer: from `statusHits.ts`;
   * `skill` — a skill's own Susceptibility or Amp, from `grants.ts`.
   */
  source: { kind: 'talent' | 'potential' | 'weapon' | 'gear-set' | 'status' | 'skill'; name: string; condition: string | null };
  /** The tiers of one talent share a group. */
  group: string;
  /** `highest` — tiers replace each other, `sum` — they add up. */
  groupMode: 'highest' | 'sum';
  tier: number;
  requires: { elite?: number; potential?: number; pieces?: number };
  /** The wiki text as it is now. */
  text: string | null;
  /** The text at the time of parsing: drift is caught against it. */
  seen: string | null;
  /** The wiki changed the text — the parse belongs to the previous patch. */
  stale: boolean;
  apply: EffectApply[];
  /**
   * A potential's edit of another effect of the same operator, by the talent's
   * name (a buff name is a fallback): stack cap, trigger, value per stack
   * («Heat DMG boost per stack +6%»), a share for the rest of the squad
   * («other allied operators gain half of this ATK buff»).
   */
  modifies?: { effect: string; stacksMax?: number; trigger?: string; valueDelta?: number; teamShare?: number } | null;
  /** What it changes in a skill's own Susceptibility or Amp (`Skill.grants`). */
  grants?: GrantModifier[];
  /** Filled where the vocabulary cannot express the effect. Damage is understated, visibly. */
  unmodeled?: string | null;
  confidence: 'confirmed' | 'inferred' | 'unknown';
  evidence?: string | null;
  note?: string | null;
  revid?: number | null;
}

/**
 * A potential's edit of a skill's own Susceptibility or Amp: Lifeng's P1 is
 * +5 % and «no more than 2 Vulnerability stacks», Xaihi's P5 ×1.1. The
 * value, duration and condition stay the skill's row.
 */
export interface GrantModifier {
  term: string;
  skillType: SkillType;
  /** Only one of Arcane's arrays. */
  variant?: string;
  /** A fraction, added after `multiplier`. */
  add?: number;
  multiplier?: number;
  durationDelta?: number;
  /** «Has no Vulnerability stacks» loosened to «no more than N». */
  atMost?: number;
}

/** The modifiers that reach this skill's grant of `term`. */
export function grantModifiers(
  mods: GrantModifier[],
  skill: { type: SkillType; variant: string | null },
  term: string,
): GrantModifier[] {
  return mods.filter(
    (mod) => mod.term === term && mod.skillType === skill.type && (mod.variant == null || mod.variant === skill.variant),
  );
}

/** A bundle record: the same as `Effect`, but rows still carry columns. */
export interface EffectEntry extends Omit<Effect, 'apply'> {
  apply: EffectApplyEntry[];
}

export interface EffectsSection {
  entries: EffectEntry[];
  covered: string[];
  counts: Record<string, number>;
  problems?: string[];
}

export const EMPTY_EFFECTS: EffectsSection = { entries: [], covered: [], counts: {} };

/** A weapon component's column: 1-based, `null` — unknown. */
export type WeaponColumns = Record<string, number | null>;

/** Elite, potential, weapon and sets — what is enabled depends on them. */
export interface EffectContext {
  operator: string;
  elite: number;
  potential: number;
  /** The weapon and each component's column (`roster.weapon.columns`). */
  weapon?: { name: string; columns: WeaponColumns } | null;
  /** Set → how many of its pieces are worn. */
  sets?: Record<string, number>;
  /** Main and secondary attributes: they resolve `MAIN` / `SUB`. */
  attributes?: { MAIN?: AttributeKey; SUB?: AttributeKey };
  /** Skill levels: a skill's own buffs (`Skill.boosts`) read their rows at them. Without — none. */
  skillLevels?: Partial<Record<SkillType, number>>;
  /** Which talent tiers are unlocked (`talents.ts`); without — every tier the elite allows. */
  talentGate?: (talent: string, elite: number) => boolean;
}

/**
 * A skill's own buffs as effect records (`Skill.boosts`, decided in
 * `export.py`), at the build's skill levels — so the track, the markers and
 * the editor's stack assumption treat them like any talent.
 *
 * A boost from the cast is a triggered row, `cast:<type>`, `@N` when only
 * that sequence grants it; one on the skill's own hits is permanent and
 * filtered by skill name. Boosts in one slot share an id: Liino's
 * Cosmovoice Stance replaces her Vocalist Stance, ATK Boost included.
 */
export function skillEffects(operator: Operator, levels: Partial<Record<SkillType, number>>): Effect[] {
  const out: Effect[] = [];
  for (const skill of operator.skills) {
    const level = levels[skill.type];
    if (level == null) continue;
    const at = (label: string): number | null => {
      const row = skill.stats.find((stat) => stat.label === label);
      return row ? (row.values[Math.min(Math.max(level, 1), row.values.length) - 1] ?? null) : null;
    };
    for (const boost of skill.boosts ?? []) {
      const value = at(boost.row);
      if (value == null) continue;
      const duration = boost.duration ? at(boost.duration) : null;
      const sequence = boost.sequence != null ? `@${boost.sequence}` : '';
      const apply: EffectApply =
        boost.when === 'own'
          ? { stat: boost.stat, unit: 'frac', value, rawValue: value * 100, target: 'self', trigger: null, skill: skill.name }
          : {
              stat: boost.stat,
              unit: 'frac',
              value,
              rawValue: value * 100,
              target: boost.target ?? 'self',
              trigger: `cast:${skill.type}${sequence}`,
              name: boost.row,
              ...(duration != null ? { duration } : {}),
            };
      out.push({
        id: `skill.${operator.key}.${boost.slot ?? skill.name}.${boost.row}`,
        operator: operator.key,
        item: skill.name,
        source: { kind: 'skill', name: skill.name, condition: boost.row },
        group: `skill.${operator.key}.${skill.name}.${boost.row}`,
        groupMode: 'sum',
        tier: 1,
        requires: {},
        text: skill.text,
        seen: null,
        stale: false,
        apply: [apply],
        confidence: 'inferred',
      });
    }
  }
  return out;
}

function owns(entry: EffectEntry, ctx: EffectContext): boolean {
  switch (entry.source.kind) {
    case 'weapon':
      return entry.item != null && entry.item === ctx.weapon?.name;
    case 'gear-set':
      return entry.item != null && (ctx.sets?.[entry.item] ?? 0) >= (entry.requires.pieces ?? 3);
    default:
      return entry.operator === ctx.operator;
  }
}

/**
 * A record's rows with the column chosen and the attribute resolved.
 *
 * A row without a column is **not applied**: filling in "some" of nine
 * values means being off several-fold (measurements, #6 — on Valiant without
 * an essence the named effect sat in column 6, with one in column 4). The
 * record stays enabled and gets an `unmodeled` note.
 */
function resolve(entry: EffectEntry, ctx: EffectContext): Effect {
  const apply: EffectApply[] = [];
  let missing = false;
  for (const line of entry.apply) {
    let value = line.value;
    let rawValue = line.rawValue;
    if (line.values) {
      const column = entry.component != null ? ctx.weapon?.columns[entry.component] : null;
      if (column == null) {
        missing = true;
        continue;
      }
      const index = Math.min(Math.max(column, 1), line.values.length) - 1;
      value = line.values[index] ?? null;
      rawValue = line.rawValues?.[index] ?? null;
    }
    if (value == null || rawValue == null) continue;
    const { values: _values, rawValues: _rawValues, attribute, ...rest } = line;
    const resolved: EffectApply = { ...rest, value, rawValue };
    if (attribute === 'MAIN' || attribute === 'SUB') {
      const key = ctx.attributes?.[attribute];
      if (!key) continue;
      resolved.attribute = key;
    } else if (attribute) {
      resolved.attribute = attribute;
    }
    apply.push(resolved);
  }
  const note = missing
    ? `skill level of "${entry.component}" is unknown (no matching Essence term) — not applied`
    : null;
  const unmodeled = [entry.unmodeled, note].filter(Boolean).join('; ') || null;
  return { ...entry, apply, unmodeled };
}

/**
 * Records enabled on this build.
 *
 * `highest` takes the top available tier: `Slashing Edge` at Elite 2 is
 * `+8 %`, not `+4 %` plus `+8 %`. `sum` adds up every available tier: that
 * is how attribute talents behave (measurements, #22), and it is also
 * visible in the shape of the data — the Elite 3 tier repeats Elite 2 and
 * would be empty if tiers replaced each other.
 */
export function activeEffects(section: EffectsSection, ctx: EffectContext): Effect[] {
  const mine = section.entries.filter((entry) => owns(entry, ctx)).map((entry) => resolve(entry, ctx));
  const available = mine.filter((entry) => {
    const { elite, potential } = entry.requires;
    if (elite != null && ctx.elite < elite) return false;
    if (elite != null && entry.source.kind === 'talent' && ctx.talentGate && !ctx.talentGate(entry.source.name, elite)) return false;
    if (potential != null && ctx.potential < potential) return false;
    return true;
  });

  const byGroup = new Map<string, Effect[]>();
  for (const entry of available) {
    const list = byGroup.get(entry.group);
    if (list) list.push(entry);
    else byGroup.set(entry.group, [entry]);
  }

  const out: Effect[] = [];
  for (const list of byGroup.values()) {
    if (list[0]?.groupMode === 'sum') {
      out.push(...list);
    } else {
      const best = list.reduce((a, b) => (b.tier > a.tier ? b : a));
      out.push(best);
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const SHEET_STATS = new Set<EffectStat>([
  'attr',
  'attr_pct',
  'atk_pct',
  'atk_attr_factor',
  'atk_flat',
  'hp_pct',
  'hp_flat',
  'dmg_reduction',
  'treatment',
  'crit_rate',
  'crit_dmg',
  'dmg_bonus',
  'arts_intensity',
  'stagger_eff',
  'ult_gain_eff',
]);

/** Permanent effects: no trigger, no stacks. */
export function isPassive(apply: EffectApply): boolean {
  return apply.trigger == null && apply.stacks == null;
}

/**
 * Whether a stat reaches the stat sheet.
 *
 * Permanent does not mean "on the sheet". A specific skill's multiplier and
 * the ultimate's cost are permanent but do not live in stats: the first
 * edits a damage instance, the second a resource. Listing them alongside
 * "ATK +15" would misstate where the number applied.
 */
export function isSheetStat(stat: EffectStat): boolean {
  return SHEET_STATS.has(stat);
}

function bucketsFor(apply: EffectApply, value: number): Partial<DmgBonusBuckets> {
  // One skill's rows: «Onomatopoeia … DMG Dealt +40%».
  if (apply.skill) return { bySkill: { [apply.skill]: value } };
  // "Arts DMG Dealt" — every element except Physical: its own bucket on the sheet.
  if (apply.element === 'Arts') return { arts: value };
  if (apply.element) return { byElement: { [apply.element]: value } };
  if (apply.skillType) return { bySkillType: { [apply.skillType]: value } };
  if (apply.staggered) return { vsStaggered: value };
  return { all: value };
}

/**
 * One effect row → a bonus on the stat sheet.
 *
 * `attributes` are needed only for `perAttribute`: the value there is given
 * **per point**, and it cannot be resolved without the computed attributes.
 */
function toExtra(
  effect: Effect,
  apply: EffectApply,
  attributes: Record<AttributeKey, number> | null,
): ExtraStats | null {
  if (!SHEET_STATS.has(apply.stat)) return null;
  const source = sourceLabel(effect);
  // Not "ATK % per point" but a bonus to the point coefficient inside
  // AttributeBonus: no multiplying by points here, the stat sheet does that.
  if (apply.stat === 'atk_attr_factor') {
    const keys = apply.perAttribute ?? [];
    if (keys.length === 0) return null;
    return { attributeFactor: Object.fromEntries(keys.map((key) => [key, apply.value])), source };
  }
  let value = apply.value;
  if (apply.perAttribute && apply.perAttribute.length > 0) {
    if (!attributes) return null;
    let points = 0;
    for (const key of apply.perAttribute) points += attributes[key] ?? 0;
    value = apply.value * points;
  }
  switch (apply.stat) {
    case 'attr':
      return apply.attribute ? { attributes: { [apply.attribute]: value }, source } : null;
    case 'atk_pct':
      return { attackPercent: value, source };
    case 'attr_pct':
      return apply.attribute ? { attributePercent: { [apply.attribute]: value }, source } : null;
    case 'atk_flat':
      return { attackFlat: value, source };
    case 'hp_pct':
      return { hpPercent: value, source };
    case 'hp_flat':
      return { hpFlat: value, source };
    case 'dmg_reduction':
      return { finalDmgReduction: value, source };
    case 'treatment':
      return { treatmentBonus: value, source };
    case 'crit_rate':
      return { critRate: value, source };
    case 'crit_dmg':
      // «When this skill … scores a critical hit, it deals higher Critical DMG»: that skill's hits only.
      if (apply.skill) return { critDmgBy: { bySkill: { [apply.skill]: value } }, source };
      if (apply.skillType) return { critDmgBy: { bySkillType: { [apply.skillType]: value } }, source };
      return { critDmg: value, source };
    case 'arts_intensity':
      return { artsIntensity: value, source };
    case 'stagger_eff':
      return { staggerEfficiency: value, source };
    case 'ult_gain_eff':
      return { ultGainEfficiency: value, source };
    case 'dmg_bonus':
      return { dmgBonus: bucketsFor(apply, value), source };
    default:
      return null;
  }
}

/** Where a bonus came from — for the UI breakdown. */
export function sourceLabel(effect: Effect): string {
  switch (effect.source.kind) {
    case 'potential':
      return `${effect.source.name} (P${effect.tier})`;
    case 'weapon':
      return `${effect.item} (${effect.source.name})`;
    case 'gear-set':
      return `${effect.item} (${effect.source.condition})`;
    default:
      return effect.source.name;
  }
}

/** A specific skill's multiplier: potentials like "DMG Multiplier ×1.1". */
export interface SkillMultiplier {
  id: string;
  source: string;
  value: number;
  skill?: string;
  skillType?: SkillType;
  /** Applies only if one of the terms is on the target. */
  targetHas?: string[];
  confidence: Effect['confidence'];
}

export interface EffectModifiers {
  /** Skill multipliers: they multiply rather than add up. */
  skillMultipliers: SkillMultiplier[];
  /** Flat cooldown change by skill type, in seconds. */
  cooldownFlat: Partial<Record<SkillType, number>>;
  /** Fractional cooldown change: −0.15 means −15 %. */
  cooldownPct: Partial<Record<SkillType, number>>;
  /** Fractional ultimate cost change: −0.15 means −15 %. */
  ultCostPct: number;
  /** Flat Stagger Dealt by skill type. */
  staggerFlat: Partial<Record<SkillType, number>>;
  /** Returned SP multiplier by skill type. */
  spReturnMult: Partial<Record<SkillType, number>>;
  /** Seconds added to a reaction applied by the wearer: Weapon Honing. */
  reactionSeconds: Record<string, number>;
  /** Bonus to a reaction's shred cap as a fraction: 0.3 means ×1.3 of the original. */
  reactionMax: Record<string, number>;
  /**
   * A reaction the wearer's skill of `skillType` applies, edited: its
   * duration and its damage per tick, as multipliers. Laevatain's P3: the
   * Combustion her battle skill forces lasts ×1.5 and burns ×1.5 (the
   * client's `duration` and `extra_scaling` of that skill).
   */
  reactionEdits: Array<{ reaction: string; skillType?: SkillType; duration: number; dot: number }>;
}

export function effectModifiers(active: Effect[]): EffectModifiers {
  const out: EffectModifiers = {
    skillMultipliers: [],
    cooldownFlat: {},
    cooldownPct: {},
    ultCostPct: 0,
    staggerFlat: {},
    spReturnMult: {},
    reactionSeconds: {},
    reactionMax: {},
    reactionEdits: [],
  };
  for (const effect of active) {
    for (const apply of effect.apply) {
      switch (apply.stat) {
        case 'skill_multiplier':
          out.skillMultipliers.push({
            id: effect.id,
            source: effect.source.name,
            value: apply.value,
            ...(apply.skill ? { skill: apply.skill } : {}),
            ...(apply.skillType ? { skillType: apply.skillType } : {}),
            ...(apply.targetHas ? { targetHas: apply.targetHas } : {}),
            confidence: effect.confidence,
          });
          break;
        case 'cooldown_flat':
          if (apply.skillType) {
            out.cooldownFlat[apply.skillType] = (out.cooldownFlat[apply.skillType] ?? 0) + apply.value;
          }
          break;
        case 'reaction_duration':
          if (apply.reaction) out.reactionSeconds[apply.reaction] = (out.reactionSeconds[apply.reaction] ?? 0) + apply.value;
          break;
        case 'reaction_max':
          if (apply.reaction) out.reactionMax[apply.reaction] = (out.reactionMax[apply.reaction] ?? 0) + apply.value;
          break;
        case 'reaction_duration_mult':
        case 'reaction_dot_mult': {
          if (!apply.reaction) break;
          let edit = out.reactionEdits.find((item) => item.reaction === apply.reaction && item.skillType === apply.skillType);
          if (!edit) {
            edit = { reaction: apply.reaction, ...(apply.skillType ? { skillType: apply.skillType } : {}), duration: 1, dot: 1 };
            out.reactionEdits.push(edit);
          }
          if (apply.stat === 'reaction_duration_mult') edit.duration *= apply.value;
          else edit.dot *= apply.value;
          break;
        }
        case 'cooldown_pct':
          if (apply.skillType) {
            out.cooldownPct[apply.skillType] = (out.cooldownPct[apply.skillType] ?? 0) + apply.value;
          }
          break;
        case 'ult_cost_pct':
          out.ultCostPct += apply.value;
          break;
        case 'stagger_flat':
          if (apply.skillType) {
            out.staggerFlat[apply.skillType] = (out.staggerFlat[apply.skillType] ?? 0) + apply.value;
          }
          break;
        case 'sp_return_mult':
          if (apply.skillType) {
            out.spReturnMult[apply.skillType] = (out.spReturnMult[apply.skillType] ?? 1) * apply.value;
          }
          break;
        default:
          break;
      }
    }
  }
  return out;
}

/**
 * A skill's multiplier, conditions included.
 *
 * Multipliers **multiply**: Mi Fu's text says outright that the P5 bonus
 * "can stack with the talent Stern Crackdown", i.e. 1.2 × 1.1, not
 * 1.2 + 0.1.
 *
 * The name in an effect may refer to a skill or to **a move within a
 * skill**. Chen's "Ascending Strike" is the battle skill itself, while Mi
 * Fu's "World Splitter" is the third move of the battle skill `Qingbo
 * Triplex` and exists on the wiki only as the prefix of a stat label:
 * `World Splitter DMG Multiplier`. So both the skill name and the instance
 * label are matched.
 */
export function skillMultiplierFor(
  modifiers: EffectModifiers,
  context: {
    skill?: string;
    skillType?: SkillType;
    /** The stat row label: it identifies the move within the skill. */
    instanceLabel?: string;
    targetTerms?: string[];
  },
): { value: number; from: SkillMultiplier[] } {
  const candidates: Array<{ entry: SkillMultiplier; byLabel: boolean }> = [];
  for (const entry of modifiers.skillMultipliers) {
    if (entry.skillType && entry.skillType !== context.skillType) continue;
    if (entry.targetHas) {
      const terms = context.targetTerms ?? [];
      if (!entry.targetHas.some((term) => terms.includes(term))) continue;
    }
    if (!entry.skill) {
      candidates.push({ entry, byLabel: false });
      continue;
    }
    const byLabel =
      context.instanceLabel != null && context.instanceLabel.startsWith(entry.skill);
    if (!byLabel && entry.skill !== context.skill) continue;
    candidates.push({ entry, byLabel });
  }

  // One effect record cannot fire twice on one instance. Camille's third
  // potential raises both the combo `Heartstake Thorn` and the move inside
  // it, `Hunter Pursuit`, each up to ×1.3 — but on the move's row that is ONE
  // multiplier of 1.3, not 1.69. So within a record the more precise match
  // wins: the move label beats the skill name.
  const byEffect = new Map<string, Array<{ entry: SkillMultiplier; byLabel: boolean }>>();
  for (const candidate of candidates) {
    const list = byEffect.get(candidate.entry.id);
    if (list) list.push(candidate);
    else byEffect.set(candidate.entry.id, [candidate]);
  }

  const from: SkillMultiplier[] = [];
  let value = 1;
  for (const list of byEffect.values()) {
    const precise = list.filter((candidate) => candidate.byLabel);
    const chosen = (precise.length > 0 ? precise : list).map((candidate) => candidate.entry);
    // Different moves of one skill in one record hit different instances,
    // and exactly one of them remains on the chosen instance.
    const best = chosen.reduce((a, b) => (b.value > a.value ? b : a));
    value *= best.value;
    from.push(best);
  }
  return { value, from };
}


/**
 * How many stacks of each triggered effect to count as up.
 *
 * It exists because "how much damage do I do" gets asked **before** a track
 * is written, while half of a build's strength hangs on stacks:
 * Endministrator's ATK +30 % from a consumed seal, Chen's five stacks of
 * ATK +8 %. Counting them as silently on would inflate the bare sheet;
 * counting them as off is wrong too, because in combat they are almost
 * always up.
 *
 * So this is an assumption, entered by hand and labelled in the UI. The
 * track, once it tracks them, sets the same numbers itself.
 */
export type AssumedStacks = Record<string, number>;

/** What the assumption adds: stats to the wearer, groups to the target. */
export interface AssumedContribution {
  extras: ExtraStats[];
  /** Σ Amp by element, like the target groups: Si's Cryo Amp does not touch Electric DMG. */
  self: { amp: Record<string, number> };
  target: {
    /** Σ "DMG Taken" by element; the `all` key — unfiltered. */
    dmgTaken: Record<string, number>;
    susceptibility: Record<string, number>;
    /** Resistance shred as a fraction (Corrosion): added to the resistance multiplier. */
    resShred: Record<string, number>;
    weaken: number[];
    protect: number[];
  };
  /** What exactly applied and at how many stacks. */
  applied: Array<{ effect: Effect; apply: EffectApply; stacks: number; value: number }>;
}

/**
 * An external buff: from a squadmate, from the target, or from the track.
 *
 * Stacks are already counted by whoever issued it (`trackBuffs` or the
 * "buffs from the squad" block); `scale` is the value fraction for
 * `teamShare`.
 */
export interface ExternalBuff {
  effect: Effect;
  apply: EffectApply;
  stacks: number;
  scale?: number;
}

export function assumeEffects(
  dynamic: DynamicEffect[],
  assumed: AssumedStacks,
  attributes: Record<AttributeKey, number> | null = null,
  external: ExternalBuff[] = [],
): AssumedContribution {
  const out: AssumedContribution = {
    extras: [],
    self: { amp: {} },
    target: { dmgTaken: {}, susceptibility: {}, resShred: {}, weaken: [], protect: [] },
    applied: [],
  };
  const lines: Array<{ effect: Effect; apply: EffectApply; stacks: number; scale: number }> = [];
  for (const { effect, apply } of dynamic) {
    // A buff for "the rest of the squad" does not reach the wearer.
    if (apply.target === 'others' || apply.target === 'spender') continue;
    const wanted = assumed[effect.id] ?? 0;
    if (wanted <= 0) continue;
    lines.push({ effect, apply, stacks: Math.min(wanted, apply.stacks?.max ?? 1), scale: 1 });
  }
  for (const buff of external) {
    if (buff.stacks > 0) lines.push({ ...buff, scale: buff.scale ?? 1 });
  }
  for (const { effect, apply, stacks, scale } of lines) {
    const scaled: EffectApply = { ...apply, value: apply.value * stacks * scale };
    out.applied.push({ effect, apply, stacks, value: scaled.value });

    if (isSheetStat(apply.stat)) {
      const extra = toExtra(effect, scaled, attributes);
      if (extra) out.extras.push(extra);
      continue;
    }
    const key = apply.element ?? 'all';
    switch (apply.stat) {
      case 'amp':
        out.self.amp[key] = (out.self.amp[key] ?? 0) + scaled.value;
        break;
      case 'dmg_taken':
        out.target.dmgTaken[key] = (out.target.dmgTaken[key] ?? 0) + scaled.value;
        break;
      case 'susceptibility':
        out.target.susceptibility[key] = (out.target.susceptibility[key] ?? 0) + scaled.value;
        break;
      case 'res_ignore':
        out.target.resShred[key] = (out.target.resShred[key] ?? 0) + scaled.value;
        break;
      case 'weaken':
        out.target.weaken.push(scaled.value);
        break;
      case 'protect':
        out.target.protect.push(scaled.value);
        break;
      default:
        // Resource edits (SP, energy) do not enter damage at all.
        break;
    }
  }
  return out;
}

/** Target sum for an instance of this element: elemental, "Arts" and unconditional. */
export function targetSumFor(byElement: Record<string, number>, element: string): number {
  const arts = ARTS_ELEMENTS.has(element) ? (byElement.Arts ?? 0) : 0;
  return (byElement[element] ?? 0) + arts + (byElement.all ?? 0);
}

/** An effect with a trigger or stacks: the track simulation follows it. */
export interface DynamicEffect {
  effect: Effect;
  apply: EffectApply;
}

/** Triggered rows that reach the wearer (without `others`). */
export function dynamicEffects(active: Effect[]): DynamicEffect[] {
  const out: DynamicEffect[] = [];
  for (const effect of active) {
    for (const apply of effect.apply) {
      if (!isPassive(apply) && apply.target !== 'others' && apply.target !== 'spender') out.push({ effect, apply });
    }
  }
  return out;
}

/** What the wearer gives the squad: `team`, `others`, `spender`. These are buffs for squadmates. */
export function teamEffects(active: Effect[]): DynamicEffect[] {
  const out: DynamicEffect[] = [];
  for (const effect of active) {
    for (const apply of effect.apply) {
      if (apply.target === 'team' || apply.target === 'others' || apply.target === 'spender') out.push({ effect, apply });
    }
  }
  return out;
}

/** What the vocabulary cannot express: the app shows it as a list. */
export function unmodeledEffects(active: Effect[]): Effect[] {
  return active.filter((effect) => effect.unmodeled);
}

export interface StatsWithEffects {
  sheet: StatSheet;
  /** Enabled records — everything that passed the elite and potential check. */
  active: Effect[];
  /** What is already on the stat sheet. */
  passive: DynamicEffect[];
  /** Permanent but not stats: skill multipliers, ultimate cost, cooldowns. */
  passiveModifiers: DynamicEffect[];
  /** What depends on the track: stacks, triggers, target debuffs. */
  dynamic: DynamicEffect[];
  /** What the wearer gives the squad — for the "buffs from the squad" block on squadmates. */
  team: DynamicEffect[];
  modifiers: EffectModifiers;
  /** What the stack assumption added, and how many stacks were taken. */
  assumed: AssumedContribution;
  unmodeled: Effect[];
  /** Records whose wiki text drifted from the parsed one. */
  stale: Effect[];
}

/**
 * The stat sheet with permanent effects.
 *
 * Two passes are not an anti-optimisation but a necessity: `perAttribute`
 * reads attributes that themselves change with talents' flat bonuses.
 * Percent ATK does not affect attributes, so two passes suffice and there
 * is no iteration to converge.
 */
export function buildStatsWithEffects(
  input: BuildInput,
  section: EffectsSection,
  context: EffectContext,
  assumedStacks: AssumedStacks = {},
  /** Buffs from the squad and the target: the track or the "buffs from the squad" block. */
  external: ExternalBuff[] = [],
): StatsWithEffects {
  const ctx = itemContext(input, context);
  const active = [...activeEffects(section, ctx), ...skillEffects(input.operator, ctx.skillLevels ?? {})];
  const passive: DynamicEffect[] = [];
  for (const effect of active) {
    for (const apply of effect.apply) {
      if (isPassive(apply)) passive.push({ effect, apply });
    }
  }

  const flat: ExtraStats[] = [];
  const scaled: DynamicEffect[] = [];
  for (const { effect, apply } of passive) {
    if (apply.perAttribute && apply.perAttribute.length > 0 && apply.stat !== 'atk_attr_factor') {
      scaled.push({ effect, apply });
      continue;
    }
    const extra = toExtra(effect, apply, null);
    if (extra) flat.push(extra);
  }

  const dynamic = dynamicEffects(active);
  // The stack assumption goes into the first pass: stacks can be flat
  // attributes, and the second pass depends on attributes.
  const assumedFlat = assumeEffects(dynamic, assumedStacks, null, external);
  const base = [...(input.extra ?? []), ...flat, ...assumedFlat.extras];
  const first = buildStats({ ...input, extra: base });
  let sheet = first;
  const assumed = assumeEffects(dynamic, assumedStacks, first.attributes, external);
  if (scaled.length > 0) {
    const second = [...(input.extra ?? []), ...flat, ...assumed.extras];
    for (const { effect, apply } of scaled) {
      const extra = toExtra(effect, apply, first.attributes);
      if (extra) second.push(extra);
    }
    sheet = buildStats({ ...input, extra: second });
  }

  return {
    sheet,
    active,
    passive: passive.filter(({ apply }) => isSheetStat(apply.stat)),
    passiveModifiers: passive.filter(({ apply }) => !isSheetStat(apply.stat)),
    dynamic,
    team: teamEffects(active),
    modifiers: effectModifiers(active),
    assumed,
    unmodeled: unmodeledEffects(active),
    stale: active.filter((effect) => effect.stale),
  };
}

/**
 * Weapon, sets and the operator's attributes come from the build itself if
 * the context does not set them. What the context sets wins: that is how a
 * test or the track can supply columns the roster does not have.
 */
export function itemContext(input: BuildInput, ctx: EffectContext): EffectContext {
  const sets: Record<string, number> = {};
  for (const slot of input.gear ?? []) {
    const set = slot?.piece.set;
    if (set) sets[set] = (sets[set] ?? 0) + 1;
  }
  const main = input.operator.mainAttribute ? ATTRIBUTE_KEY[input.operator.mainAttribute] : undefined;
  const sub = input.operator.subAttribute ? ATTRIBUTE_KEY[input.operator.subAttribute] : undefined;
  return {
    ...ctx,
    weapon:
      ctx.weapon !== undefined
        ? ctx.weapon
        : input.weapon
          ? { name: input.weapon.weapon.key, columns: input.weapon.columns ?? {} }
          : null,
    sets: ctx.sets ?? sets,
    attributes: ctx.attributes ?? { ...(main ? { MAIN: main } : {}), ...(sub ? { SUB: sub } : {}) },
  };
}
