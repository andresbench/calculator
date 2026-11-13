/**
 * A build's stat sheet: operator + weapon + gear.
 *
 * ```
 * Attack = ((operator ATK + weapon ATK) × PercentBonuses + FixedBonus) × AttributeBonus
 * AttributeBonus = 1 + Σ over STR/AGL/INT/WIL: attribute × coefficient
 * coefficient = 0.005 for the main, 0.002 for the secondary, 0 for the rest
 *               + effect bonuses (`atk_attr_factor`)
 * ```
 *
 * The coefficients are separate client attributes,
 * `AtkIncreaseFactorFrom{Str,Agi,Wisd,Will}` (datamine; measurements, #36).
 * Lifeng's Illumination works through them, not through ATK %.
 *
 * Two things that matter more than all the other arithmetic.
 *
 * **Only the operator's main and secondary attributes count** (measured
 * 2026-09-04). The other four give exactly zero. A point of the main
 * attribute is worth exactly 2.5 times a point of the secondary. Hence the
 * gear rule: an item with a foreign attribute as its main stat is half
 * empty, and with a foreign secondary too it is empty altogether — which
 * costs more than almost any set bonus.
 *
 * **Percent ATK is worth less than its face value.** The talent "ATK
 * +30 %" gave ×1.204, because percentages add up in one group and are
 * diluted by those already collected. "ATK +X %" cannot be compared with
 * "DMG Bonus +X %" at face value.
 *
 * Talents, potentials and weapon effects arrive here ready-made, through
 * `extra`: parsing them from text is a separate layer (`effects.ts`), and
 * mechanical summing must not be mixed with interpreting text.
 */

import type { Message } from './messages.js';
import type { AttributeKey, GearPiece, Operator, SkillType, Unit, Weapon } from './bundle.js';
import { operatorAttribute, weaponAttack } from './curve.js';

/** Attribute name in the UI → curve key in the data. */
export const ATTRIBUTE_KEY: Record<string, AttributeKey> = {
  Agility: 'AGL',
  Strength: 'STR',
  Intellect: 'INT',
  Will: 'WIL',
};

export const ELEMENTS = ['Physical', 'Heat', 'Cryo', 'Electric', 'Nature', 'Aether'] as const;

/** Elements counted as "arts": `Arts DMG` applies to them. */
export const ARTS_ELEMENTS = new Set(['Heat', 'Cryo', 'Electric', 'Nature', 'Aether']);

/** A term tagged with where it came from. Reaches the UI. */
export interface Contribution {
  source: string;
  value: number;
}

export interface DmgBonusBuckets {
  /** "Physical DMG Bonus", "Heat DMG" and so on by element. */
  byElement: Record<string, number>;
  /** "Arts DMG" — every element except Physical. */
  arts: number;
  /** "Battle Skill DMG Bonus" and its kin. */
  bySkillType: Partial<Record<SkillType, number>>;
  /** «All Skill DMG». */
  allSkill: number;
  /** «DMG Bonus vs. Staggered». */
  vsStaggered: number;
  /** «DMG Dealt +X % for all types of DMG». */
  all: number;
  /** One skill's rows only: Estella's P3 «Onomatopoeia … DMG Dealt +40%». By skill or move name. */
  bySkill: Record<string, number>;
}

/** Crit damage on top of `critDmg`, for one skill or one skill type. */
export interface CritDmgBuckets {
  bySkill: Record<string, number>;
  bySkillType: Partial<Record<SkillType, number>>;
}

export interface StatSheet {
  attributes: Record<AttributeKey, number>;
  mainAttribute: string | null;
  subAttribute: string | null;
  attributeBonus: number;
  /** Final attack — what goes into the damage formula. */
  attack: number;
  baseAttack: number;
  attackPercent: number;
  attackFlat: number;
  hp: number;
  defense: number;
  critRate: number;
  critDmg: number;
  artsIntensity: number;
  ultGainEfficiency: number;
  staggerEfficiency: number;
  finalDmgReduction: number;
  treatmentBonus: number;
  dmgBonus: DmgBonusBuckets;
  /** Crit damage that reaches one skill only: Rossi's ultimate «deals higher Critical DMG». */
  critDmgBy: CritDmgBuckets;
  /** Breakdown by term: why the attack and attributes are what they are. */
  breakdown: Record<string, Contribution[]>;
  warnings: Message[];
}

/** What came not from the data but from parsed effects or manual input. */
export interface ExtraStats {
  attributes?: Partial<Record<AttributeKey, number>>;
  attackPercent?: number;
  attackFlat?: number;
  critRate?: number;
  critDmg?: number;
  artsIntensity?: number;
  staggerEfficiency?: number;
  ultGainEfficiency?: number;
  hpPercent?: number;
  hpFlat?: number;
  finalDmgReduction?: number;
  treatmentBonus?: number;
  /** "Secondary attribute +32 %": a percent of the full attribute. */
  attributePercent?: Partial<Record<AttributeKey, number>>;
  dmgBonus?: Partial<DmgBonusBuckets>;
  critDmgBy?: Partial<CritDmgBuckets>;
  /** Bonus to an attribute point's coefficient inside AttributeBonus. */
  attributeFactor?: Partial<Record<AttributeKey, number>>;
  /** For the breakdown: who granted the bonus. */
  source?: string;
}

export interface BuildInput {
  operator: Operator;
  level: number;
  weapon?: {
    weapon: Weapon;
    level?: number;
    rank?: number;
    breakthrough?: number;
    /** Each component's column by essence (`roster.weapon.columns`). */
    columns?: Record<string, number | null>;
  } | null;
  /** Four slots: gloves, armor and two kits. An empty slot is `null`. */
  gear?: Array<{ piece: GearPiece; tier?: number } | null>;
  extra?: ExtraStats[];
}

function emptyBuckets(): DmgBonusBuckets {
  return { byElement: {}, arts: 0, bySkillType: {}, allSkill: 0, vsStaggered: 0, all: 0, bySkill: {} };
}

function addBuckets(target: DmgBonusBuckets, source: Partial<DmgBonusBuckets>): void {
  for (const [element, value] of Object.entries(source.byElement ?? {})) {
    target.byElement[element] = (target.byElement[element] ?? 0) + value;
  }
  for (const [type, value] of Object.entries(source.bySkillType ?? {})) {
    const key = type as SkillType;
    target.bySkillType[key] = (target.bySkillType[key] ?? 0) + (value ?? 0);
  }
  for (const [skill, value] of Object.entries(source.bySkill ?? {})) {
    target.bySkill[skill] = (target.bySkill[skill] ?? 0) + value;
  }
  target.arts += source.arts ?? 0;
  target.allSkill += source.allSkill ?? 0;
  target.vsStaggered += source.vsStaggered ?? 0;
  target.all += source.all ?? 0;
}

/**
 * Sorts one gear stat into the sheet's buckets.
 *
 * "Main Attribute" and "Secondary Attribute" are not stats of their own
 * but references to the operator's attributes: the same item gives
 * different attributes on different operators.
 */
function applyGearStat(
  sheet: {
    attributes: Record<AttributeKey, number>;
    attributePercent: Partial<Record<AttributeKey, number>>;
    dmgBonus: DmgBonusBuckets;
    scalars: Record<string, number>;
  },
  statName: string,
  unit: Unit,
  value: number,
  operator: Operator,
  note: (bucket: string, contribution: Contribution) => void,
  source: string,
): boolean {
  const resolved =
    statName === 'Main Attribute'
      ? operator.mainAttribute
      : statName === 'Secondary Attribute'
        ? operator.subAttribute
        : statName;

  if (resolved && ATTRIBUTE_KEY[resolved]) {
    const key = ATTRIBUTE_KEY[resolved]!;
    // "Secondary Attribute +13.5%" is a percent of the attribute, not 0.135
    // points. Applied at the end, to the sum of all flat bonuses.
    if (unit === 'frac') {
      sheet.attributePercent[key] = (sheet.attributePercent[key] ?? 0) + value;
      return true;
    }
    sheet.attributes[key] += value;
    note(`attribute ${resolved}`, { source, value });
    return true;
  }

  switch (statName) {
    // Attack and HP come in both units: "Attack +16.2" and "Attack +12%".
    case 'Attack':
      if (unit === 'flat') {
        sheet.scalars.attackFlat! += value;
        note('ATK', { source, value });
      } else {
        sheet.scalars.attackPercent! += value;
        note('ATK %', { source, value });
      }
      return true;
    case 'HP':
      if (unit === 'flat') sheet.scalars.hpFlat! += value;
      else sheet.scalars.hpPercent! += value;
      return true;
    case 'Arts Intensity':
      sheet.scalars.artsIntensity! += value;
      note('Arts Intensity', { source, value });
      return true;
    case 'Critical Rate':
      sheet.scalars.critRate! += value;
      note('Critical Rate', { source, value });
      return true;
    case 'Ultimate Gain Efficiency':
      sheet.scalars.ultGainEfficiency! += value;
      return true;
    case 'Final DMG Reduction':
      sheet.scalars.finalDmgReduction! += value;
      return true;
    case 'Treatment Bonus':
      sheet.scalars.treatmentBonus! += value;
      return true;
    case 'All Skill DMG':
      sheet.dmgBonus.allSkill += value;
      note('DMG Bonus', { source: `${source} (all skills)`, value });
      return true;
    case 'Arts DMG':
      sheet.dmgBonus.arts += value;
      note('DMG Bonus', { source: `${source} (Arts)`, value });
      return true;
    case 'DMG Bonus vs. Staggered':
      sheet.dmgBonus.vsStaggered += value;
      note('DMG Bonus', { source: `${source} (vs staggered)`, value });
      return true;
    default:
      break;
  }

  const skillType = /^(Basic Attack|Battle Skill|Combo Skill|Ultimate) DMG Bonus$/.exec(statName);
  if (skillType) {
    const key = skillType[1] as SkillType;
    sheet.dmgBonus.bySkillType[key] = (sheet.dmgBonus.bySkillType[key] ?? 0) + value;
    note('DMG Bonus', { source: `${source} (${key})`, value });
    return true;
  }

  const single = /^(Physical|Heat|Cryo|Electric|Nature|Aether) DMG(?: Bonus)?$/.exec(statName);
  if (single) {
    const element = single[1]!;
    sheet.dmgBonus.byElement[element] = (sheet.dmgBonus.byElement[element] ?? 0) + value;
    note('DMG Bonus', { source: `${source} (${element})`, value });
    return true;
  }

  // Paired stats like "Cryo & Electric DMG" — one number for two elements.
  const pair = /^(\w+) & (\w+) DMG$/.exec(statName);
  if (pair) {
    for (const element of [pair[1]!, pair[2]!]) {
      sheet.dmgBonus.byElement[element] = (sheet.dmgBonus.byElement[element] ?? 0) + value;
    }
    note('DMG Bonus', { source: `${source} (${pair[1]} and ${pair[2]})`, value });
    return true;
  }

  return false;
}

export function buildStats(input: BuildInput): StatSheet {
  const { operator, level } = input;
  const breakdown: Record<string, Contribution[]> = {};
  const warnings: Message[] = [];

  const note = (bucket: string, contribution: Contribution): void => {
    if (contribution.value === 0) return;
    (breakdown[bucket] ??= []).push(contribution);
  };

  const attributes: Record<AttributeKey, number> = { HP: 0, ATK: 0, STR: 0, AGL: 0, INT: 0, WIL: 0 };
  for (const key of ['HP', 'ATK', 'STR', 'AGL', 'INT', 'WIL'] as AttributeKey[]) {
    const value = operatorAttribute(operator, key, level);
    if (value == null) {
      warnings.push({ code: 'statsNoCurve', stat: key });
      continue;
    }
    attributes[key] = value;
    if (key !== 'HP' && key !== 'ATK') note(`attribute ${key}`, { source: `${operator.name} lv ${level}`, value });
  }

  const dmgBonus = emptyBuckets();
  const critDmgBy: CritDmgBuckets = { bySkill: {}, bySkillType: {} };
  const scalars: Record<string, number> = {
    attackPercent: 0,
    attackFlat: 0,
    hpPercent: 0,
    hpFlat: 0,
    artsIntensity: 0,
    critRate: operator.critRate ?? 0.05,
    critDmg: 0.5,
    ultGainEfficiency: 0,
    staggerEfficiency: 0,
    finalDmgReduction: 0,
    treatmentBonus: 0,
  };

  const operatorAtk = attributes.ATK;
  note('Attack', { source: `${operator.name} lv ${level}`, value: operatorAtk });

  let weaponAtk = 0;
  if (input.weapon) {
    const value = weaponAttack(input.weapon.weapon, input.weapon.level ?? level);
    if (value == null) {
      warnings.push({ code: 'statsNoWeaponAtk', weapon: input.weapon.weapon.name });
    } else {
      weaponAtk = value;
      note('Attack', { source: input.weapon.weapon.name, value });
    }
    // Weapon effects are NOT filled in here: the effects layer picks the
    // column (`effects.ts`), and they arrive through `extra`.
  } else {
    warnings.push({ code: 'statsNoWeapon' });
  }

  const attributePercent: Partial<Record<AttributeKey, number>> = {};
  const attributeFactor: Partial<Record<AttributeKey, number>> = {};
  const sheetRef = { attributes, attributePercent, dmgBonus, scalars };

  let gearCount = 0;
  for (const slot of input.gear ?? []) {
    if (!slot) continue;
    gearCount += 1;
    const { piece } = slot;
    const tier = slot.tier ?? (piece.artifice ? piece.stats[0]?.values.length ?? 1 : 1) - 1;
    for (const stat of piece.stats) {
      const value = stat.values[Math.min(tier, stat.values.length - 1)];
      if (value == null) continue;
      const ok = applyGearStat(sheetRef, stat.stat, stat.unit, value, operator, note, piece.name);
      if (!ok) warnings.push({ code: 'statsGearStatUnparsed', stat: stat.stat, piece: piece.name });
    }
  }
  if (gearCount === 0) warnings.push({ code: 'statsNoGear' });
  if (gearCount > 4) warnings.push({ code: 'statsTooMuchGear', count: gearCount });

  for (const extra of input.extra ?? []) {
    const source = extra.source ?? 'effect';
    for (const [key, value] of Object.entries(extra.attributes ?? {})) {
      attributes[key as AttributeKey] += value ?? 0;
      note(`attribute ${key}`, { source, value: value ?? 0 });
    }
    scalars.attackPercent! += extra.attackPercent ?? 0;
    scalars.attackFlat! += extra.attackFlat ?? 0;
    scalars.critRate! += extra.critRate ?? 0;
    scalars.critDmg! += extra.critDmg ?? 0;
    scalars.artsIntensity! += extra.artsIntensity ?? 0;
    scalars.staggerEfficiency! += extra.staggerEfficiency ?? 0;
    scalars.ultGainEfficiency! += extra.ultGainEfficiency ?? 0;
    scalars.hpPercent! += extra.hpPercent ?? 0;
    scalars.hpFlat! += extra.hpFlat ?? 0;
    scalars.finalDmgReduction! += extra.finalDmgReduction ?? 0;
    scalars.treatmentBonus! += extra.treatmentBonus ?? 0;
    for (const [key, value] of Object.entries(extra.attributePercent ?? {})) {
      attributePercent[key as AttributeKey] = (attributePercent[key as AttributeKey] ?? 0) + (value ?? 0);
    }
    if (extra.attackPercent) note('ATK %', { source, value: extra.attackPercent });
    if (extra.artsIntensity) note('Arts Intensity', { source, value: extra.artsIntensity });
    if (extra.dmgBonus) addBuckets(dmgBonus, extra.dmgBonus);
    for (const [name, value] of Object.entries(extra.critDmgBy?.bySkill ?? {})) {
      critDmgBy.bySkill[name] = (critDmgBy.bySkill[name] ?? 0) + value;
    }
    for (const [type, value] of Object.entries(extra.critDmgBy?.bySkillType ?? {})) {
      critDmgBy.bySkillType[type as SkillType] = (critDmgBy.bySkillType[type as SkillType] ?? 0) + (value ?? 0);
    }
    for (const [key, value] of Object.entries(extra.attributeFactor ?? {})) {
      attributeFactor[key as AttributeKey] = (attributeFactor[key as AttributeKey] ?? 0) + (value ?? 0);
      note('AttributeBonus', { source: `${source}: ${key} × ${value}`, value: value ?? 0 });
    }
  }

  // A percent of an attribute is of the full sum, talents and weapon stat
  // included. The wiki does not name the base; settled by measurement
  // (measurements, #28, `confirmed`).
  for (const [key, percent] of Object.entries(attributePercent) as Array<[AttributeKey, number]>) {
    const value = attributes[key] * percent;
    attributes[key] += value;
    note(`attribute ${key}`, { source: `+${(percent * 100).toFixed(1)} % of the attribute`, value });
  }

  const mainKey = operator.mainAttribute ? ATTRIBUTE_KEY[operator.mainAttribute] : undefined;
  const subKey = operator.subAttribute ? ATTRIBUTE_KEY[operator.subAttribute] : undefined;
  let attributeBonus = 1;
  for (const key of ['STR', 'AGL', 'INT', 'WIL'] as AttributeKey[]) {
    const rate = (key === mainKey ? 0.005 : 0) + (key === subKey ? 0.002 : 0) + (attributeFactor[key] ?? 0);
    // Integer part of the attribute, as on screen: the Variante kit rounds
    // down, and without it Lifeng's hits are off by 1.6–2.6 (measurements, #36).
    attributeBonus += Math.floor(attributes[key]) * rate;
  }

  const baseAttack = operatorAtk + weaponAtk;
  const attack = (baseAttack * (1 + scalars.attackPercent!) + scalars.attackFlat!) * attributeBonus;

  return {
    attributes,
    mainAttribute: operator.mainAttribute,
    subAttribute: operator.subAttribute,
    attributeBonus,
    attack,
    baseAttack,
    attackPercent: scalars.attackPercent!,
    attackFlat: scalars.attackFlat!,
    // "Each point of Strength increases the Base HP by 5" — the wiki's
    // `Attribute` page; matches Endministrator's screen (measurements, #24:
    // HP −275 = 5 × 55 STR). That HP % also applies to this bonus is an
    // assumption.
    hp: (attributes.HP + 5 * Math.floor(attributes.STR)) * (1 + scalars.hpPercent!) + scalars.hpFlat!,
    defense: 0,
    critRate: scalars.critRate!,
    critDmg: scalars.critDmg!,
    artsIntensity: scalars.artsIntensity!,
    ultGainEfficiency: scalars.ultGainEfficiency!,
    staggerEfficiency: scalars.staggerEfficiency!,
    finalDmgReduction: scalars.finalDmgReduction!,
    treatmentBonus: scalars.treatmentBonus!,
    dmgBonus,
    critDmgBy,
    breakdown,
    warnings,
  };
}

/** Crit damage for a hit of this skill: the sheet's, plus what reaches this skill or its type. */
export function critDmgFor(sheet: StatSheet, skill: { name: string; type: SkillType }): number {
  return sheet.critDmg + (sheet.critDmgBy.bySkill[skill.name] ?? 0) + (sheet.critDmgBy.bySkillType[skill.type] ?? 0);
}

/**
 * An element line on the stat screen: "Physical DMG +30.0 %".
 *
 * The game spreads "DMG Dealt +X % for all types" into **every** element
 * line, Physical included (measurements, #23: Pogranichnik's screen in AIC
 * Fieldwork — Physical 30 = 20 set + 10 P2, the other elements 20 each).
 * Whether "Arts DMG" shows in the element lines on screen has not been
 * seen, so it is left out here; it does enter damage via `dmgBonusFor`.
 */
export function screenElementBonus(sheet: StatSheet, element: string): number {
  return (sheet.dmgBonus.byElement[element] ?? 0) + sheet.dmgBonus.all;
}

/**
 * The "DMG Bonus" sum for a given instance.
 *
 * It is all one additive group: the game adds "DMG Dealt" and "DMG Bonus"
 * together and shows them as one number on the stat screen (measured
 * 2026-09-06).
 */
export function dmgBonusFor(
  sheet: StatSheet,
  context: { element: string; skillType?: SkillType; staggered?: boolean; skill?: string; instanceLabel?: string },
): number {
  const buckets = sheet.dmgBonus;
  let total = buckets.all;
  // A bonus to one skill: by the skill's name, or by a move's name that
  // starts the row label (moves within a battle skill exist only in labels).
  for (const [name, value] of Object.entries(buckets.bySkill)) {
    if (name === context.skill || (context.instanceLabel != null && context.instanceLabel.startsWith(name))) total += value;
  }
  // «All Skill DMG» is battle skill, combo and ultimate: basic attacks and
  // statuses do not take it (measurements, #38).
  if (context.skillType && context.skillType !== 'Basic Attack') total += buckets.allSkill;
  total += buckets.byElement[context.element] ?? 0;
  if (ARTS_ELEMENTS.has(context.element)) total += buckets.arts;
  if (context.skillType) total += buckets.bySkillType[context.skillType] ?? 0;
  if (context.staggered) total += buckets.vsStaggered;
  return total;
}
