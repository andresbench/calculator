/**
 * The page reads an Enka showcase the way `tools/ef/profile.py: extract`
 * does. `showcase-parity.json` is written by `profile.py parity`: synthetic
 * showcase characters (no account) and `extract`'s record for each, the
 * weapon columns as `export.py` puts them in the roster. If this fails after
 * a change on either side, one of the two readers is wrong.
 */

import { readFileSync } from 'node:fs';

import { expect, it } from 'vitest';

import {
  buildFromRoster,
  readCharacter,
  readShowcase,
  uidFromSource,
  type Bundle,
  type ShowcaseCharacter,
  type ShowcaseRecord,
} from '../src/index.js';
import { describeWithBundle } from './support/bundle.js';

const CASES = JSON.parse(readFileSync(new URL('./fixtures/showcase-parity.json', import.meta.url), 'utf8')) as {
  cases: Array<{ operator: string | null; char: ShowcaseCharacter; expected: ShowcaseRecord | null }>;
};

it('a UID comes from a number or a showcase link; an account link is told apart', () => {
  expect(uidFromSource(' 1234567890 ')).toEqual({ uid: '1234567890' });
  expect(uidFromSource('https://enka.network/ef/1234567890/')).toEqual({ uid: '1234567890' });
  expect(uidFromSource('https://enka.network/u/someone/abc/')).toEqual({ failure: 'account_link' });
  expect(uidFromSource('hello')).toEqual({ failure: 'bad_source' });
});

describeWithBundle('a showcase read in the page, against profile.py', (bundle: Bundle) => {
  const tables = bundle.showcase!;

  it('the bundle carries the tables', () => {
    expect(Object.keys(tables.weapons).length).toBeGreaterThan(0);
    expect(Object.keys(tables.gear).length).toBeGreaterThan(0);
  });

  for (const { operator, char, expected } of CASES.cases) {
    it(`${operator ?? 'an operator not in the data'}: the same record as extract`, () => {
      expect(readCharacter(char, bundle, tables)).toEqual(expected);
    });
  }

  it('a read showcase builds: the weapon, the gear by slot, the columns from the essence', () => {
    const chars = CASES.cases.filter((item) => item.expected?.weapon?.name).map((item) => item.char);
    const read = readShowcase({ uid: '100000000', ttl: 60, playerInfo: { charData: chars } }, bundle);
    const [key, entry] = Object.entries(read.entries)[0]!;
    const build = buildFromRoster(entry, bundle);
    expect(build.operatorKey).toBe(key);
    expect(build.weaponKey).toBe(entry.weapon!.name);
    expect(build.provenance.weapon).toBe('profile');
    expect(build.provenance.elite).toBe('default');
    for (const piece of entry.gear) if (piece.name) expect(build.gear[piece.slot]?.key).toBe(piece.name);
    expect(read.ttl).toBe(60);
  });
});
