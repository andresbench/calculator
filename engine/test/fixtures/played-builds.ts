/**
 * The builds the rotations in `rotations/` are played with.
 *
 * Copied from the roster on 2026-10-29. Pinned here because the acceptance
 * test is about rotations as they are played: skill levels set cooldowns and
 * elite opens talents, and a live roster would change the test every time an
 * operator is levelled up. Update deliberately, together with the rotations.
 */

import type { MemberSpec } from '../support/bundle.js';

type Skills = MemberSpec['skills'];

const build = (elite: number, potential: number, skills: Skills): MemberSpec & { potential: number } => ({
  level: 90,
  elite,
  potential,
  skills,
});

const all = (level: number): Skills => ({ basic: level, battle: level, combo: level, ultimate: level });

export const PLAYED: Record<string, MemberSpec & { potential: number }> = {
  Alesh: build(4, 5, { basic: 9, battle: 10, combo: 12, ultimate: 10 }),
  Antal: build(3, 5, all(6)),
  Arcane: build(4, 0, all(12)),
  Camille: build(4, 0, { basic: 6, battle: 12, combo: 11, ultimate: 11 }),
  'Chen Qianyu': build(4, 5, { basic: 11, battle: 12, combo: 12, ultimate: 12 }),
  Ember: build(4, 1, { basic: 7, battle: 9, combo: 12, ultimate: 10 }),
  'Endministrator (female)': build(4, 4, all(12)),
  Estella: build(4, 5, { basic: 9, battle: 9, combo: 10, ultimate: 9 }),
  Lifeng: build(4, 0, { basic: 6, battle: 12, combo: 12, ultimate: 12 }),
  'Mi Fu': build(4, 1, all(12)),
  Perlica: build(4, 5, { basic: 3, battle: 11, combo: 12, ultimate: 9 }),
  Pogranichnik: build(4, 2, { basic: 9, battle: 12, combo: 12, ultimate: 12 }),
  Rossi: build(4, 0, { basic: 9, battle: 8, combo: 12, ultimate: 11 }),
  Tangtang: build(4, 0, { basic: 10, battle: 12, combo: 12, ultimate: 11 }),
  Xaihi: build(4, 5, { basic: 3, battle: 10, combo: 9, ultimate: 12 }),
};
