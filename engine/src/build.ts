/**
 * A build and its damage table: the bridge between the roster and the formula.
 *
 * The roster describes what the account has; the formula wants specific
 * items at specific tiers. In between sits name resolution and, above all,
 * **an honest mark of what we do not know**.
 *
 * `analyse` is the one place a build turns into per-hit damage. The build
 * editor shows its table, and the track sums the same rows (`trackDamage`),
 * so the two cannot disagree about a hit.
 */

import type { GearPiece, Bundle, Operator, Provenance, RosterEntry, SkillType, TalentNodes, WeaponColumn } from './bundle.js';
import { computeDamage, type DamageResult } from './damage.js';
import { talentGate } from './talents.js';
import {
  buildStatsWithEffects,
  skillMultiplierFor,
  sourceLabel,
  targetSumFor,
  type AssumedContribution,
  type AssumedStacks,
  type DynamicEffect,
  type Effect,
  type EffectModifiers,
  type ExternalBuff,
  type SkillMultiplier,
} from './effects.js';
import type { Message } from './messages.js';
import { critDmgFor, dmgBonusFor, type StatSheet } from './stats.js';

/** An editable build. This is what the app saves in the browser. */
export interface Build {
  operatorKey: string;
  level: number;
  elite: number;
  potential: number;
  skills: { basic: number; battle: number; combo: number; ultimate: number };
  weaponKey: string | null;
  weaponLevel: number;
  /**
   * Skill level of each weapon component, 1-based, keyed by component name.
   * `undefined` means "whatever the roster's Essence says"; an explicit
   * object is a manual override.
   */
  weaponColumns?: Record<string, number | null> | undefined;
  /** Four slots: gloves, armor, kit, kit. */
  gear: Array<{ key: string; tier: number } | null>;
  /** Where each field came from. A default and a fact must not look the same. */
  provenance: Record<string, Provenance>;
  /** Unlocked talent nodes; missing — every tier the elite allows. */
  talentNodes?: TalentNodes;
}

/** Slot order as the Enka showcase reports it. Verified: 62 pieces, no misses. */
export const SLOT_NAMES = ['Gloves', 'Armor', 'Kit', 'Kit'] as const;
export const SLOT_TYPES: Array<GearPiece['type']> = ['Gloves', 'Armor', 'Kit', 'Kit'];

const DEFAULT_SKILLS = { basic: 1, battle: 1, combo: 1, ultimate: 1 };

/** Roster entry → editable build. */
export function buildFromRoster(entry: RosterEntry, bundle: Bundle): Build {
  const gear: Build['gear'] = [null, null, null, null];
  for (const item of entry.gear ?? []) {
    if (item.slot == null || !item.name) continue;
    const piece = bundle.gear.pieces[item.name];
    if (!piece) continue;
    // The showcase does not report the upgrade tier: take the maximum and
    // mark it as an assumption through provenance.
    const tier = piece.stats[0] ? piece.stats[0].values.length - 1 : 0;
    if (item.slot >= 0 && item.slot < 4) gear[item.slot] = { key: item.name, tier };
  }

  return {
    operatorKey: entry.key,
    level: entry.level ?? 90,
    elite: entry.elite ?? 4,
    potential: entry.potential ?? 0,
    skills: entry.skills ?? DEFAULT_SKILLS,
    weaponKey: entry.weapon?.name ?? null,
    weaponLevel: entry.weapon?.level ?? entry.level ?? 90,
    gear,
    provenance: entry.provenance ?? {},
    ...(entry.talentNodes ? { talentNodes: entry.talentNodes } : {}),
  };
}

/** What the showcase says about this operator, or an empty build. */
export function showcaseBuild(operatorKey: string, bundle: Bundle): Build {
  const entry = bundle.roster?.operators?.[operatorKey];
  return entry ? buildFromRoster(entry, bundle) : emptyBuild(operatorKey);
}

/** An empty build for an operator not in the roster. */
export function emptyBuild(operatorKey: string): Build {
  return {
    operatorKey,
    level: 90,
    elite: 4,
    potential: 0,
    skills: { ...DEFAULT_SKILLS },
    weaponKey: null,
    weaponLevel: 90,
    gear: [null, null, null, null],
    provenance: {
      level: 'default',
      elite: 'default',
      potential: 'default',
      skills: 'default',
      weapon: 'default',
      gear: 'default',
    },
  };
}

/**
 * Where the weapon's skill levels come from, per component.
 *
 * The roster carries columns that `export.py` derived from the infused
 * Essence (measurements, #6). They describe that one weapon instance, so
 * they apply only while the build wields the roster's weapon.
 */
export function weaponColumns(
  build: Build,
  bundle: Bundle,
): { columns: Record<string, number | null>; resolved: Record<string, WeaponColumn> | null } {
  const roster = bundle.roster?.operators[build.operatorKey]?.weapon;
  const resolved = roster && roster.name === build.weaponKey ? roster.columns : null;
  if (build.weaponColumns) return { columns: build.weaponColumns, resolved };
  const columns: Record<string, number | null> = {};
  for (const [key, hit] of Object.entries(resolved ?? {})) columns[key] = hit.column;
  return { columns, resolved };
}

export interface BuildAnalysis {
  operator: Operator;
  sheet: StatSheet;
  /** Which sets are assembled and how many pieces. The bonus needs three. */
  sets: Array<{ name: string; count: number; active: boolean; text: string | null }>;
  /** One row per damage INSTANCE, not per skill. */
  skills: Array<{
    id: string;
    type: SkillType;
    name: string;
    icon: string | null;
    label: string;
    multiplier: number;
    /** How many times the row hits per cast; null — not known. Damage is per hit. */
    count: number | null;
    /** The multiplier from potentials and talents on this particular instance. */
    skillMultiplier: number;
    multiplierFrom: SkillMultiplier[];
    /** Crit damage of this row (`critDmgFor`): the expected hit on the track takes it. */
    critDmg: number;
    result: DamageResult;
  }>;
  /** Parsed effects: what went into stats, what depends on the track. */
  effects: {
    assumed: AssumedContribution;
    passive: DynamicEffect[];
    passiveModifiers: DynamicEffect[];
    dynamic: DynamicEffect[];
    /** What the wearer gives the rest of the team. */
    team: DynamicEffect[];
    /** Everything switched on for this build: what the track's buff timeline reads. */
    active: Effect[];
    unmodeled: Effect[];
    stale: Effect[];
    modifiers: EffectModifiers;
    /** No placement has been written for this operator at all. */
    missing: boolean;
  };
  /** What the engine does not account for yet. Shown next to the numbers. */
  unaccounted: Message[];
}

export interface DummyState {
  enemyKey: string | null;
  tier: number;
  staggered: boolean;
  crit: boolean;
  /**
   * How many stacks of triggered effects to count as up.
   *
   * This is an assumption, and it is labelled: half of a build's strength
   * hangs on stacks that the bare sheet does not have. Keyed by the bundle's
   * effect id.
   */
  assume: AssumedStacks;
  /**
   * Finisher ATK Mult when no enemy is picked: the dummy with a typical
   * class's stagger meter (`dummyTarget`). An enemy's own number wins.
   */
  finisherMultiplier?: number;
}

const SKILL_FIELD: Record<SkillType, keyof Build['skills']> = {
  'Basic Attack': 'basic',
  'Battle Skill': 'battle',
  'Combo Skill': 'combo',
  Ultimate: 'ultimate',
};

/** The id `analyse` gives a skill's damage row; `trackDamage` looks rows up by it. */
export function rowId(skill: Operator['skills'][number], label: string): string {
  return `${skill.type}:${skill.variant ?? ''}:${label}`;
}

/**
 * All of a skill's damage instances, not one.
 *
 * Taking the first multiplier found is wrong. Chen's ultimate has these
 * stats: `Slash Multiplier` 81 % and `Final Strike DMG Multiplier` 1023 %,
 * and the ultimate itself is six slashes plus the finisher. Showing 81 % as
 * "the ultimate's damage" would be off tenfold.
 *
 * The measurements think in instances too: Endministrator's ultimate frame
 * is three numbers (shards, bonus hit, main hit), and identifying the
 * instance is the first rule of a clean measurement there.
 */
function damageRows(skill: Operator['skills'][number]): Operator['skills'][number]['stats'] {
  // Whether a row is a hit, a per-stack bonus or a conditional hit is decided
  // by `export.py` (`hit_roles`); all three are shown here.
  return skill.stats.filter((stat) => stat.hit != null);
}

/**
 * `external` — buffs that come from outside the build: the track's buff
 * timeline, or teammates in the editor. Same code path as the editor's own
 * "assume stacks", so a buff counts the same wherever it comes from.
 */
export function analyse(
  build: Build,
  bundle: Bundle,
  dummy: DummyState,
  external: ExternalBuff[] = [],
): BuildAnalysis | null {
  const operator = bundle.operators[build.operatorKey];
  if (!operator) return null;

  const weapon = build.weaponKey ? bundle.weapons[build.weaponKey] : null;
  const gear = build.gear.map((slot) => {
    if (!slot) return null;
    const piece = bundle.gear.pieces[slot.key];
    return piece ? { piece, tier: slot.tier } : null;
  });

  // Talents, potentials, weapons and sets come from the hand-written effects
  // layer rather than being guessed from text here: there is one parse, in
  // `data/endfield/effects/*.yaml`.
  const withEffects = buildStatsWithEffects(
    {
      operator,
      level: build.level,
      weapon: weapon
        ? { weapon, level: build.weaponLevel, columns: weaponColumns(build, bundle).columns }
        : null,
      gear,
    },
    bundle.effects,
    {
      operator: build.operatorKey,
      elite: build.elite,
      potential: build.potential,
      ...(build.talentNodes ? { talentGate: talentGate(bundle.operators[build.operatorKey], build.talentNodes) } : {}),
      skillLevels: {
        'Basic Attack': build.skills.basic,
        'Battle Skill': build.skills.battle,
        'Combo Skill': build.skills.combo,
        Ultimate: build.skills.ultimate,
      },
    },
    dummy.assume ?? {},
    external,
  );
  const sheet = withEffects.sheet;
  const assumed = withEffects.assumed;

  // Sets: the bonus needs three pieces and there are four slots, so one is
  // always free for an item from another set.
  const counts = new Map<string, number>();
  for (const slot of gear) {
    const set = slot?.piece.set;
    if (set) counts.set(set, (counts.get(set) ?? 0) + 1);
  }
  const sets = [...counts.entries()]
    .map(([name, count]) => ({
      name,
      count,
      active: count >= 3,
      text: bundle.gear.sets[name]?.text ?? null,
    }))
    .sort((a, b) => b.count - a.count);

  const enemy = dummy.enemyKey ? bundle.enemies[dummy.enemyKey] : null;
  const tierIndex = enemy ? Math.min(dummy.tier, enemy.def.length - 1) : 0;
  const resistance = enemy
    ? (enemy.resistances[operator.element] ?? 1)
    : 1;
  const finisherMultiplier = enemy ? enemy.finisherMultiplier : dummy.finisherMultiplier;

  const skills = operator.skills.flatMap((skill) => {
    const level = build.skills[SKILL_FIELD[skill.type]] ?? 1;
    return damageRows(skill).map((row) => {
      const index = Math.min(Math.max(level, 1), row.values.length) - 1;
      const multiplier = row.values[index] ?? 0;
      const staggered = dummy.staggered;
      // A finisher exists only on a staggered target: off it, the row is a plain hit.
      const finisher = staggered && row.hit?.part === 'finisher';
      // Potentials like "DMG Multiplier ×1.1" edit not a stat but a specific
      // instance, so the multiplier is looked up by skill name AND by row
      // label: moves within a battle skill exist only in labels.
      const { value: skillMultiplier, from: multiplierFrom } = skillMultiplierFor(
        withEffects.modifiers,
        {
          skill: skill.name,
          skillType: skill.type,
          instanceLabel: row.label,
          targetTerms: staggered ? ['Staggered'] : [],
        },
      );
      const result = computeDamage({
        attack: sheet.attack,
        baseMultiplier: multiplier * skillMultiplier,
        kind: 'skill',
        // The hit's own kind: Laevatain's enhanced basic attacks are ultimate
        // rows at the ultimate's level, but Basic Attack DMG to the client.
        dmgBonus: dmgBonusFor(sheet, {
          element: operator.element,
          skillType: row.dealtAs ?? skill.type,
          staggered,
        }),
        critDmg: dummy.crit ? critDmgFor(sheet, { name: skill.name, type: row.dealtAs ?? skill.type }) : null,
        staggered,
        ...(finisher && finisherMultiplier != null ? { finisherMultiplier } : {}),
        def: enemy ? (enemy.def[tierIndex] ?? 100) : 100,
        resistance,
        ...(enemy ? { resistanceConfidence: enemy.resistanceConfidence } : {}),
        operatorLevel: build.level,
        artsIntensity: sheet.artsIntensity,
        // Target groups from the stack assumption. The element filter matters:
        // Endministrator's "Physical DMG Taken" does not apply to an arts instance.
        amp: targetSumFor(assumed.self.amp, operator.element),
        increasedDmgTaken: targetSumFor(assumed.target.dmgTaken, operator.element),
        susceptibility: targetSumFor(assumed.target.susceptibility, operator.element),
        corrosionShred: targetSumFor(assumed.target.resShred, operator.element),
        // Weaken and Protection from the effects layer are deliberately left
        // out. In the formula Weaken sits on the attacker and Protect on the
        // target; ours land the other way round — Weaken on the enemy (it
        // hits softer), Protection on us — so neither changes our damage.
      });
      return {
        id: rowId(skill, row.label),
        type: skill.type,
        name: skill.name,
        icon: skill.icon,
        label: row.label,
        multiplier,
        count: row.hit?.count === undefined ? 1 : row.hit.count,
        skillMultiplier,
        multiplierFrom,
        // The crit damage this row would deal: Rossi's ultimate has its own on top.
        critDmg: critDmgFor(sheet, { name: skill.name, type: row.dealtAs ?? skill.type }),
        result,
      };
    });
  });

  // An honest list of what the numbers leave out. Without it the damage
  // table looks more precise than it is.
  const missing = !bundle.effects.covered.includes(build.operatorKey);
  const unaccounted: Message[] = [];
  if (missing) unaccounted.push({ code: 'noLayout', operator: build.operatorKey, talents: operator.talents.length });
  for (const effect of withEffects.unmodeled) {
    const where = effect.operator == null
      ? sourceLabel(effect)
      : `${effect.source.name} (${effect.source.condition})`;
    unaccounted.push({ code: 'unmodeled', where, text: effect.unmodeled ?? '' });
  }
  for (const effect of withEffects.stale) {
    unaccounted.push({ code: 'staleLayout', effect: sourceLabel(effect) });
  }
  // Weapons and sets without a written layout. Stat components are always
  // laid out mechanically, so this only catches the named effect.
  const named = weapon?.components.find((component) => !/ \[[LMS]\]$/.test(component.key));
  if (weapon && named && !withEffects.active.some((e) => e.item === weapon.key && e.component === named.key)) {
    unaccounted.push({ code: 'weaponNoLayout', weapon: weapon.name, component: named.key });
  }
  for (const set of sets.filter((set) => set.active)) {
    if (!withEffects.active.some((e) => e.source.kind === 'gear-set' && e.item === set.name)) {
      unaccounted.push({ code: 'setNoLayout', set: set.name });
    }
  }

  return {
    operator,
    sheet,
    sets,
    skills,
    effects: {
      assumed,
      passive: withEffects.passive,
      passiveModifiers: withEffects.passiveModifiers,
      dynamic: withEffects.dynamic,
      team: withEffects.team,
      active: withEffects.active,
      unmodeled: withEffects.unmodeled,
      stale: withEffects.stale,
      modifiers: withEffects.modifiers,
      missing,
    },
    unaccounted,
  };
}
