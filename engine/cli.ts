#!/usr/bin/env -S npx tsx
/**
 * The engine CLI: the same numbers as the app, from a terminal.
 *
 * It exists for two reasons. First, agent skills must compute damage with
 * the same code as the UI, or the project grows two formulas that drift
 * apart. Second, a breakdown is easier to read as text when checking a
 * measurement.
 *
 * Usage::
 *
 *     npm run calc -- "Chen Qianyu" --skill battle
 *     npm run calc -- "Mi Fu" --skill combo --enemy "Alleikhreos, Chiliarch"
 *     npm run calc -- "Chen Qianyu" --skill battle --arts-intensity 26.9
 *     npm run calc -- "Endmin" --skill battle --potential 1
 *     npm run calc -- --list
 */

import {
  buildStatsWithEffects,
  computeDamage,
  dmgBonusFor,
  formatMessage,
  skillMultiplierFor,
  type Bundle,
  type DamageInput,
  type Operator,
  type SkillType,
} from './src/index.js';

import { loadBundle } from './load.js';


const SKILL_ALIAS: Record<string, SkillType> = {
  basic: 'Basic Attack',
  ba: 'Basic Attack',
  battle: 'Battle Skill',
  bs: 'Battle Skill',
  combo: 'Combo Skill',
  cs: 'Combo Skill',
  ult: 'Ultimate',
  ultimate: 'Ultimate',
};

interface Options {
  operator?: string;
  skill: SkillType;
  level: number;
  skillLevel: number;
  elite?: number;
  potential: number;
  enemy?: string;
  tier: number;
  artsIntensity?: number;
  crit: boolean;
  staggered: boolean;
  list: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    skill: 'Battle Skill',
    level: 90,
    skillLevel: 12,
    potential: 0,
    tier: 5,
    crit: false,
    staggered: false,
    list: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const next = (): string => argv[(i += 1)] ?? '';
    switch (arg) {
      case '--skill':
        options.skill = SKILL_ALIAS[next().toLowerCase()] ?? 'Battle Skill';
        break;
      case '--level':
        options.level = Number(next());
        break;
      case '--skill-level':
        options.skillLevel = Number(next());
        break;
      case '--elite':
        options.elite = Number(next());
        break;
      case '--potential':
        options.potential = Number(next());
        break;
      case '--enemy':
        options.enemy = next();
        break;
      case '--tier':
        options.tier = Number(next());
        break;
      case '--arts-intensity':
        options.artsIntensity = Number(next());
        break;
      case '--crit':
        options.crit = true;
        break;
      case '--staggered':
        options.staggered = true;
        break;
      case '--list':
        options.list = true;
        break;
      default:
        // A multi-word name: npm run -- "Chen Qianyu" arrives here as two
        // arguments, so everything that is not a flag is joined.
        if (!arg.startsWith('--')) {
          options.operator = options.operator ? `${options.operator} ${arg}` : arg;
        }
    }
  }
  return options;
}

function findOperator(bundle: Bundle, query: string): Operator | null {
  const needle = query.toLowerCase();
  const exact = Object.values(bundle.operators).find(
    (operator) => operator.key.toLowerCase() === needle || operator.name.toLowerCase() === needle,
  );
  if (exact) return exact;
  return (
    Object.values(bundle.operators).find((operator) =>
      operator.name.toLowerCase().includes(needle),
    ) ?? null
  );
}

/** A skill's damage multiplier at the given skill level. */
function damageMultiplier(
  operator: Operator,
  skillType: SkillType,
  skillLevel: number,
): { value: number; label: string } | null {
  const skill = operator.skills.find((candidate) => candidate.type === skillType);
  if (!skill) return null;
  const row =
    skill.stats.find((stat) => stat.label === 'DMG Multiplier') ??
    skill.stats.find((stat) => stat.unit === 'frac' && /multiplier/i.test(stat.label));
  if (!row) return null;
  const index = Math.min(Math.max(skillLevel, 1), row.values.length) - 1;
  return { value: row.values[index] ?? 0, label: row.label };
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const bundle = loadBundle();

  if (options.list || !options.operator) {
    const names = Object.values(bundle.operators)
      .filter((operator) => !operator.upcoming)
      .map((operator) => `${operator.name} (${operator.element}, ${operator.class})`)
      .sort();
    console.log(`Operators in the database: ${names.length}\n`);
    for (const name of names) console.log('  ' + name);
    console.log('\nExample: npm run calc -- "Chen Qianyu" --skill battle');
    return;
  }

  const operator = findOperator(bundle, options.operator);
  if (!operator) {
    console.error(`No operator "${options.operator}". List them: --list`);
    process.exit(1);
  }

  // Elite decides which talents are enabled, and arguments usually omit it.
  // By default take the highest the level already allows: the stat curve
  // does not depend on promotion (see curve.ts), but talents do.
  const elite =
    options.elite ??
    operator.breakpoints
      .filter((point) => point.level <= options.level)
      .reduce((best, point) => Math.max(best, point.elite), 0);
  const withEffects = buildStatsWithEffects(
    { operator, level: options.level },
    bundle.effects,
    { operator: operator.key, elite, potential: options.potential },
  );
  const sheet = withEffects.sheet;
  const multiplier = damageMultiplier(operator, options.skill, options.skillLevel);
  if (!multiplier) {
    console.error(`${operator.name} has no damage multiplier on "${options.skill}".`);
    process.exit(1);
  }

  const enemy = options.enemy ? bundle.enemies[options.enemy] : undefined;
  if (options.enemy && !enemy) {
    console.error(`No enemy "${options.enemy}" in the database.`);
    process.exit(1);
  }
  const tierIndex = Math.min(options.tier, (enemy?.def.length ?? 1) - 1);
  const resistance = enemy?.resistances[operator.element as keyof typeof enemy.resistances] ?? 1;

  const skillName = operator.skills.find((candidate) => candidate.type === options.skill)?.name;
  const boost = skillMultiplierFor(withEffects.modifiers, {
    ...(skillName ? { skill: skillName } : {}),
    skillType: options.skill,
    instanceLabel: multiplier.label,
    targetTerms: options.staggered ? ['Staggered'] : [],
  });

  const input: DamageInput = {
    attack: sheet.attack,
    baseMultiplier: multiplier.value * boost.value,
    kind: 'skill',
    dmgBonus: dmgBonusFor(sheet, {
      element: operator.element,
      skillType: options.skill,
      staggered: options.staggered,
    }),
    critDmg: options.crit ? sheet.critDmg : null,
    staggered: options.staggered,
    def: enemy?.def[tierIndex] ?? 100,
    resistance,
    ...(enemy ? { resistanceConfidence: enemy.resistanceConfidence } : {}),
    operatorLevel: options.level,
    artsIntensity: options.artsIntensity ?? sheet.artsIntensity,
  };

  const result = computeDamage(input);

  console.log(
    `${operator.name} · lv ${options.level} · E${elite} · P${options.potential} · ` +
      `${options.skill} lv ${options.skillLevel}`,
  );
  console.log(
    `${multiplier.label}: ${(multiplier.value * 100).toFixed(0)} %` +
      (boost.value === 1
        ? ''
        : ` × ${boost.value.toFixed(2)} (${boost.from.map((from) => from.source).join(', ')})`),
  );
  if (enemy) {
    console.log(`Target: ${enemy.name} (${enemy.class}), DEF ${input.def}, resistance ${resistance}`);
  } else {
    console.log('Target: dummy, DEF 100, no resistance');
  }
  console.log('');

  const width = Math.max(...result.factors.map((factor) => factor.name.length));
  for (const factor of result.factors) {
    const mark = factor.confidence === 'confirmed' ? ' ' : factor.confidence === 'inferred' ? '~' : '?';
    console.log(`  ${mark} ${factor.name.padEnd(width)}  ×${formatNumber(factor.value)}`);
  }
  console.log('');
  console.log(`  DAMAGE: ${formatNumber(result.damage)}`);
  console.log(`  confidence: ${result.confidence}`);

  for (const note of result.notes) console.log(`  ! ${formatMessage(note)}`);
  for (const warning of sheet.warnings) console.log(`  ! ${formatMessage(warning)}`);

  // Effects: what is already in the number, what waits for the track, what
  // the vocabulary cannot express. The last is a direct sign of how far the
  // number is understated.
  if (withEffects.passive.length > 0) {
    console.log('\n  in the stat sheet:');
    for (const { effect, apply } of withEffects.passive) {
      console.log(`    ${effect.source.name} — ${apply.stat} ${apply.rawValue}`);
    }
  }
  if (withEffects.passiveModifiers.length > 0) {
    console.log('\n  skill and resource tweaks:');
    for (const { effect, apply } of withEffects.passiveModifiers) {
      const what = apply.skill ?? apply.skillType ?? 'skill';
      console.log(`    ${effect.source.name} — ${apply.stat} ${apply.rawValue} (${what})`);
    }
  }
  if (withEffects.dynamic.length > 0) {
    console.log('\n  from the track (NOT in the number):');
    for (const { effect, apply } of withEffects.dynamic) {
      const stacks = apply.stacks ? ` ×${apply.stacks.max}` : '';
      console.log(
        `    ${effect.source.name} — ${apply.stat} ${apply.rawValue}${stacks}` +
          ` on "${apply.trigger ?? '?'}"`,
      );
    }
  }
  if (withEffects.unmodeled.length > 0) {
    console.log('\n  not expressible by the vocabulary:');
    for (const effect of withEffects.unmodeled) {
      console.log(`    ${effect.source.name} — ${effect.unmodeled}`);
    }
  }
  for (const effect of withEffects.stale) {
    console.log(`  ! ${effect.source.name}: the wiki text changed since it was parsed`);
  }
  if (!bundle.effects.covered.includes(operator.key)) {
    console.log('\n  ! no effect layout for this operator yet — talents and potentials are not counted');
  }

  console.log('\n  ~ inferred indirectly, ? not verified. Built from bundle schema ' + bundle.schema);
}

main();
