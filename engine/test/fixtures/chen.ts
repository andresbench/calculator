/**
 * Fixture: Chen Qianyu and her gear from the measurements.
 *
 * The numbers are copied from `data/endfield/` by hand rather than read from
 * the bundle. Reason: the bundle is generated and not versioned, and the
 * tests must pass on a fresh clone. To keep the fixture from drifting from
 * the data, `test/bundle-sync.test.ts` checks it against the real bundle
 * when one is built, and stays silent when not.
 *
 * The kit is from the 2026-09-04 measurement: exactly this gear was on Chen,
 * and exactly this armor pair (Qingbo against Swordmancer) gave a clean
 * one-stat swap (measurements, #3).
 */

import type { Breakpoint, GearPiece, Operator, Weapon } from '../../src/index.js';

export const BREAKPOINTS: Breakpoint[] = [
  { key: 'base', elite: 0, level: 1 },
  { key: 'elite1_lv20', elite: 1, level: 20 },
  { key: 'elite2_lv40', elite: 2, level: 40 },
  { key: 'elite3_lv60', elite: 3, level: 60 },
  { key: 'elite4_lv80', elite: 4, level: 80 },
  { key: 'elite4_lv90', elite: 4, level: 90 },
];

export const CHEN = {
  key: 'Chen Qianyu',
  id: 'chr_0005_chen',
  name: 'Chen Qianyu',
  rarity: 5,
  class: 'Guard',
  element: 'Physical',
  weaponType: 'Sword',
  faction: 'Endfield Industries',
  gender: 'Female',
  mainAttribute: 'Agility',
  subAttribute: 'Strength',
  tags: ['Lift', 'Stagger'],
  headhunting: 'standard',
  upcoming: false,
  critRate: 0.05,
  attackSpeed: 1,
  attackRange: '3 Meters',
  attributes: {
    HP: { base: 500, elite1_lv20: 1566, elite2_lv40: 2689, elite3_lv60: 3811, elite4_lv80: 4934, elite4_lv90: 5495 },
    ATK: { base: 30, elite1_lv20: 87, elite2_lv40: 147, elite3_lv60: 207, elite4_lv80: 267, elite4_lv90: 297 },
    AGL: { base: 20.567, elite1_lv20: 52.844, elite2_lv40: 86.821, elite3_lv60: 120.797, elite4_lv80: 154.773, elite4_lv90: 171.762 },
    STR: { base: 10.773, elite1_lv20: 31.242, elite2_lv40: 52.788, elite3_lv60: 74.335, elite4_lv80: 95.881, elite4_lv90: 106.654 },
    INT: { base: 8.865, elite1_lv20: 25.279, elite2_lv40: 42.557, elite3_lv60: 59.834, elite4_lv80: 77.112, elite4_lv90: 85.75 },
    WIL: { base: 9.69, elite1_lv20: 27.671, elite2_lv40: 46.598, elite3_lv60: 65.525, elite4_lv80: 84.452, elite4_lv90: 93.915 },
  },
  breakpoints: BREAKPOINTS,
  skills: [],
  talents: [],
  potentials: [],
  icon: null,
  elementIcon: null,
  classIcon: null,
  revid: 55945,
  page: 'Chen Qianyu',
} satisfies Operator;

export const SUNDERING_STEEL = {
  key: 'Sundering Steel',
  id: 'wpn_sword_0005',
  name: 'Sundering Steel',
  rarity: 5,
  type: 'Sword',
  baseAttack: { base: 42, elite1_lv20: 120, elite2_lv40: 203, elite3_lv60: 286, elite4_lv80: 369, elite4_lv90: 411 },
  breakpoints: BREAKPOINTS,
  skillName: null,
  components: [],
  potential: null,
  icon: null,
  revid: 61878,
  page: 'Sundering Steel',
} satisfies Weapon;

function piece(
  name: string,
  type: GearPiece['type'],
  set: string,
  defense: number,
  stats: Array<[GearStatSlot, string, number[], ('flat' | 'frac')?]>,
): GearPiece {
  return {
    key: name,
    name,
    type,
    rarity: 5,
    level: 70,
    set,
    defense,
    // Artifact gear: four tiers of values instead of one.
    artifice: true,
    region: 'Wuling',
    // The unit cannot always be guessed from the name: attributes, Attack
    // and HP come in both. Then it is given explicitly, as in the bundle.
    stats: stats.map(([slot, stat, values, unit]) => ({
      slot,
      stat,
      unit:
        unit ??
        (['Agility', 'Strength', 'Intellect', 'Will', 'Arts Intensity'].includes(stat) ? 'flat' : 'frac'),
      values,
    })),
    icon: null,
    page: name,
  };
}

type GearStatSlot = 'primary' | 'secondary' | 'tertiary';

/**
 * The control pair from the measurement: attributes match to the point, only
 * the third stat differs. Ultimate Gain Efficiency does not affect damage at
 * all, so exactly Arts Intensity +26.9 changes between configs.
 */
export const QINGBO_HEAVY_ARMOR = piece('Qingbo Heavy Armor', 'Armor', 'Qingbo', 56, [
  ['primary', 'Agility', [87, 95, 104, 113]],
  ['secondary', 'Strength', [58, 63, 69, 75]],
  ['tertiary', 'Ultimate Gain Efficiency', [0.123, 0.136, 0.148, 0.16]],
]);

export const SWORDMANCER_HEAVY_ARMOR = piece('Swordmancer Heavy Armor', 'Armor', 'Swordmancer', 56, [
  ['primary', 'Agility', [87, 95, 104, 113]],
  ['secondary', 'Strength', [58, 63, 69, 75]],
  ['tertiary', 'Arts Intensity', [20.7, 22.8, 24.8, 26.9]],
]);

export const SWORDMANCER_TAC_GAUNTLETS = piece(
  'Swordmancer TAC Gauntlets',
  'Gloves',
  'Swordmancer',
  42,
  [
    ['primary', 'Agility', [65, 71, 78, 84]],
    ['secondary', 'Strength', [43, 47, 51, 55]],
    ['tertiary', 'Ultimate DMG Bonus', [0.431, 0.474, 0.517, 0.561]],
  ],
);

export const SWORDMANCER_FLINT = piece('Swordmancer Flint', 'Kit', 'Swordmancer', 21, [
  ['primary', 'Agility', [32, 35, 38, 41]],
  ['secondary', 'Strength', [21, 23, 25, 27]],
  ['tertiary', 'Physical DMG Bonus', [0.23, 0.253, 0.276, 0.299]],
]);

export const GRIZZLED_EDGE_GAUNTLETS_T1 = piece(
  'Grizzled Edge Gauntlets T1',
  'Gloves',
  'Grizzled Edge',
  42,
  [
    ['primary', 'Agility', [65, 71, 78, 84]],
    ['secondary', 'Strength', [43, 47, 51, 55]],
    ['tertiary', 'Arts Intensity', [34.5, 38, 41.4, 44.9]],
  ],
);

/** An item with attributes foreign to Chen — to check the gear rule. */
export const GRIZZLED_EDGE_GAUNTLETS = piece('Grizzled Edge Gauntlets', 'Gloves', 'Grizzled Edge', 42, [
  ['primary', 'Strength', [65, 71, 78, 84]],
  ['secondary', 'Will', [43, 47, 51, 55]],
  ['tertiary', 'Arts Intensity', [34.5, 38, 41.4, 44.9]],
]);

/** A percent attribute: "Secondary Attribute +13.5%", not 0.135 points. */
export const FRONTIERS_ARMOR_T3 = piece('Frontiers Armor T3', 'Armor', 'Frontiers', 56, [
  ['primary', 'Agility', [87, 95, 104, 113]],
  ['secondary', 'Intellect', [58, 63, 69, 75]],
  ['tertiary', 'Secondary Attribute', [0.104, 0.114, 0.124, 0.135], 'frac'],
]);

/** Flat attack: "Attack +16.2", not +1620 %. Early gear, one tier. */
export const MORDVOLT_INSULATION_VEST: GearPiece = {
  ...piece('Mordvolt Insulation Vest', 'Armor', 'Mordvolt Insulation', 28, [
    ['primary', 'Intellect', [44]],
    ['secondary', 'Strength', [29]],
    ['tertiary', 'Attack', [16.2], 'flat'],
  ]),
  rarity: 3,
  level: 36,
  artifice: false,
  region: 'Valley IV',
};
