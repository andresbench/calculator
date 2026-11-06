/**
 * Which actions an operator has at all (the rotation editor's palette).
 *
 * The palette must offer exactly what the operator can do. The action list
 * is derived from skill data rather than written by hand: otherwise a fifth
 * battle skill stage would appear for someone who has three, and a rotation
 * that cannot be played would look valid.
 *
 * **A stage is a press, not a hit.** The wiki writes `SEQ 1 DMG
 * Multiplier`, `SEQ 2 …` for both, and they are different things: Mi Fu's
 * battle skill is three presses, each with its own cost (the `sequences`
 * array in "SP Cost": 100 / 50 / 50), while Lifeng's is one press that
 * swings three times. So stages are offered only when a cost row — SP Cost,
 * Cooldown, Ultimate Energy Cost — is split by stage, or the ultimate has two
 * phases. Labels give the count once that is settled; the larger wins.
 * Pogranichnik's combo is the third kind: one press, and the stacks it
 * consumed decide how many slashes it makes (`Skill.moves`).
 *
 * A special case is "per SEQ": Akekuri's combo is described as "DMG
 * Multiplier per SEQ", so there are some stages, but the data does not say
 * how many. Then the action is offered without a number rather than with an
 * invented one.
 */

import type { Operator, Skill, SkillType } from './bundle.js';
import type { ActionKind } from './timing.js';

export interface ActionOption {
  kind: ActionKind;
  /** Stage number, or `null` for a single-stage skill. */
  sequence: number | null;
  /** How it is written in `.rot`: `BS`, `BS2`, `CS1`. */
  token: string;
  /** Skill name; for a stage, the move name if the wiki gives one. */
  name: string;
  skillType: SkillType;
  /** Label of the stat row the move comes from. For the tooltip. */
  instanceLabel?: string;
}

const SEQ_LABEL = /(?:^|\s)SEQ\s*(\d+)/i;
const PER_SEQ = /per\s+SEQ/i;
const MOVE_LABEL = /^(.+?)\s+DMG Multiplier$/;

/**
 * How many stages a skill has.
 *
 * Zero means "one stage, or the count is unknown" — either way the action
 * is written without a number.
 */
export function sequenceCount(skill: Skill): number {
  let count = 0;
  for (const row of skill.stats) {
    if (row.sequences) count = Math.max(count, row.sequences.length);
    // Basic attack labels (`BATK SEQ 3`) are steps of the chain, not skill
    // stages: the notation does not write them.
    if (row.label.startsWith('BATK')) continue;
    const match = SEQ_LABEL.exec(row.label);
    if (match) count = Math.max(count, Number(match[1]));
  }
  return count;
}

/**
 * Whether the stages are separate presses: a cost split by stage, or a
 * two-phase ultimate. Otherwise `SEQ n` rows are hits of one cast.
 */
export function stagesArePresses(skill: Skill): boolean {
  return Boolean(skill.switch) || skill.stats.some((row) => row.sequences && row.sequences.length > 1);
}

/**
 * Move names by stage, if the wiki gives them.
 *
 * Returns a list only when there are exactly as many names as stages: Mi Fu
 * has `Cloudtrapper` / `Trail and Mangle` / `World Splitter`, while Camille's
 * three-stage combo names a single move, and spreading it over the numbers
 * would be a guess.
 */
export function moveNames(skill: Skill, count: number): string[] | null {
  if (count < 2) return null;
  const names: string[] = [];
  for (const row of skill.stats) {
    if (row.label.startsWith('BATK')) continue;
    const match = MOVE_LABEL.exec(row.label);
    if (!match) continue;
    const name = match[1]!.trim();
    if (SEQ_LABEL.test(name) || name === '') continue;
    if (!names.includes(name)) names.push(name);
  }
  return names.length === count ? names : null;
}

function hasLabel(skill: Skill | undefined, needle: RegExp): boolean {
  return Boolean(skill?.stats.some((row) => needle.test(row.label)));
}

/**
 * All of an operator's actions for the editor palette.
 *
 * In the order they are pressed: basic attack, final strike, finisher,
 * dive, then battle skill, combo and ultimate.
 */
export function actionsFor(operator: Operator): ActionOption[] {
  const byType = new Map<SkillType, Skill>();
  for (const skill of operator.skills) {
    // Arcane has two stances, so the skills are duplicated. The palette takes
    // the first: both stances have the same actions, only the numbers differ.
    if (!byType.has(skill.type)) byType.set(skill.type, skill);
  }

  const basic = byType.get('Basic Attack');
  const out: ActionOption[] = [];

  if (basic) {
    out.push({ kind: 'BA', sequence: null, token: 'BA', name: basic.name, skillType: 'Basic Attack' });
    out.push({
      kind: 'FS',
      sequence: null,
      token: 'FS',
      name: `${basic.name} — Final Strike`,
      skillType: 'Basic Attack',
    });
    if (hasLabel(basic, /Finisher ATK Multiplier/i)) {
      out.push({ kind: 'FIN', sequence: null, token: 'FIN', name: 'Finisher', skillType: 'Basic Attack' });
    }
    if (hasLabel(basic, /Dive ATK Multiplier/i)) {
      out.push({ kind: 'DIVE', sequence: null, token: 'DIVE', name: 'Dive attack', skillType: 'Basic Attack' });
    }
  }

  const staged: Array<{ kind: ActionKind; type: SkillType }> = [
    { kind: 'BS', type: 'Battle Skill' },
    { kind: 'CS', type: 'Combo Skill' },
    { kind: 'ULT', type: 'Ultimate' },
  ];

  for (const { kind, type } of staged) {
    const skill = byType.get(type);
    if (!skill) continue;
    const count = sequenceCount(skill);
    const unknown = skill.stats.some((row) => PER_SEQ.test(row.label));
    if (count < 2 || unknown || !stagesArePresses(skill)) {
      out.push({ kind, sequence: null, token: kind, name: skill.name, skillType: type });
      continue;
    }
    const names = moveNames(skill, count);
    for (let index = 1; index <= count; index += 1) {
      const move = names?.[index - 1];
      out.push({
        kind,
        sequence: index,
        token: `${kind}${index}`,
        name: move ? `${skill.name}: ${move}` : `${skill.name}, stage ${index}`,
        skillType: type,
        ...(move ? { instanceLabel: `${move} DMG Multiplier` } : {}),
      });
    }
  }

  return out;
}
