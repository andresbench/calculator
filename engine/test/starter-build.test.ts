/**
 * The starter build: what an operator nobody has entered starts with on the
 * site. Skills at 9, a 4★ weapon of their type, a full AIC Fieldwork set —
 * and every field still marked `default`, because it is a stand-in.
 */

import { expect, it } from 'vitest';

import { emptyBuild, SLOT_TYPES, starterBuild } from '../src/index.js';
import { describeWithBundle } from './support/bundle.js';

describeWithBundle('the starter build', (bundle) => {
  const released = Object.values(bundle.operators).filter((operator) => !operator.upcoming);

  it('gives every operator a 4★ weapon of their own type, columns at 9', () => {
    const wrong: string[] = [];
    for (const operator of released) {
      const build = starterBuild(operator.key, bundle);
      const weapon = build.weaponKey ? bundle.weapons[build.weaponKey] : undefined;
      if (!weapon || weapon.rarity !== 4 || weapon.type !== operator.weaponType) wrong.push(operator.key);
      if (Object.values(build.weaponColumns ?? {}).some((level) => level !== 9)) wrong.push(`${operator.key} columns`);
    }
    expect(wrong).toEqual([]);
  });

  it('prefers the weapon whose attribute is the main one', () => {
    // Laevatain: a Sword on Intellect — Wave Tide, not the Agility one.
    expect(starterBuild('Laevatain', bundle).weaponKey).toBe('Wave Tide');
    // Alesh: a Sword on Strength — neither matches, so the Suppression one.
    expect(starterBuild('Alesh', bundle).weaponKey).toBe('Prominent Edge');
  });

  it('dresses everyone in a full AIC Fieldwork set, slot types in order', () => {
    for (const operator of released) {
      const gear = starterBuild(operator.key, bundle).gear;
      const pieces = gear.map((slot) => (slot ? bundle.gear.pieces[slot.key] : undefined));
      expect(pieces.map((piece) => piece?.set), operator.key).toEqual(Array(4).fill('AIC Fieldwork'));
      expect(pieces.map((piece) => piece?.type), operator.key).toEqual(SLOT_TYPES);
    }
  });

  it('matches the DMG line to the element', () => {
    expect(starterBuild('Chen Qianyu', bundle).gear[1]?.key).toBe('AIC Fieldwork CQB Armor');
    expect(starterBuild('Laevatain', bundle).gear[1]?.key).toBe('AIC Fieldwork Armor');
  });

  it('keeps skills at 9 and every field marked as a default', () => {
    const build = starterBuild('Lifeng', bundle);
    expect(build.skills).toEqual({ basic: 9, battle: 9, combo: 9, ultimate: 9 });
    expect(Object.values(build.provenance)).toEqual(Array(6).fill('default'));
  });

  it('leaves emptyBuild bare: tests start from it', () => {
    const build = emptyBuild('Lifeng');
    expect(build.weaponKey).toBeNull();
    expect(build.gear).toEqual([null, null, null, null]);
  });
});
