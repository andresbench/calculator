/**
 * Which talent tiers are really open: talent nodes are unlocked one by one
 * (gifts to the operator), apart from elite.
 *
 * The showcase reports them (`TalentNodes`): the attribute talent's open
 * tiers, and each other talent's tier, in the order the operator lists them
 * — without the attribute talent and `Outfitting` (gear quality). Measured
 * on Argent Flow (#59): Elite 4, no attribute node, and his stat screen's
 * Will was the four tiers of `Stalwart` (+60) lower than the elite gives.
 */

import type { Operator, TalentNodes } from './bundle.js';

/** «Operator Will +10.» — every tier of an attribute talent reads like this. */
const ATTRIBUTE_TIER = /^Operator \w+ \+\d+\.?$/;
/** «Activate this to let the operator equip … gear» — not a combat talent. */
const OUTFITTING = /\bequip\b.*\bgear\b/i;

function eliteOf(condition: string | null | undefined): number | null {
  const found = /Elite (\d)/.exec(condition ?? '');
  return found ? Number(found[1]) : null;
}

/**
 * `(talent, elite) → open?` for one operator. A tier is open when its rank
 * among the talent's tiers is below the open count; a talent the showcase
 * says nothing about stays open as the elite allows.
 */
export function talentGate(operator: Operator | undefined, nodes: TalentNodes): (talent: string, elite: number) => boolean {
  if (!operator) return () => true;
  const tiers = new Map<string, { attribute: boolean; elites: number[] }>();
  const passive: string[] = [];
  for (const talent of operator.talents ?? []) {
    const texts = talent.levels.map((level) => level.text.trim());
    if (texts.length > 0 && texts.every((text) => OUTFITTING.test(text))) continue;
    const attribute = texts.length > 0 && texts.every((text) => ATTRIBUTE_TIER.test(text));
    const elites = [...new Set(talent.levels.map((level) => eliteOf(level.condition)).filter((e): e is number => e != null))].sort(
      (a, b) => a - b,
    );
    tiers.set(talent.name, { attribute, elites });
    if (!attribute) passive.push(talent.name);
  }
  return (name, elite) => {
    const talent = tiers.get(name);
    if (!talent) return true;
    const rank = talent.elites.indexOf(elite);
    if (rank < 0) return true;
    if (talent.attribute) return rank < nodes.attribute;
    const open = nodes.passive[passive.indexOf(name)];
    return open == null ? true : rank < open;
  };
}
