/**
 * What is stored in the browser or imported from a file is not trusted: a
 * build without `gear` made the track throw while rendering and left the
 * page white after every reload (the state is what the page loads). The
 * checkers fill what is missing from the empty build and drop what cannot
 * stand alone; nothing here may throw, whatever it is given.
 */

import { describe, expect, it } from 'vitest';

import {
  analyse,
  emptyBuild,
  normaliseBuild,
  normaliseDraft,
  normaliseDrafts,
  normaliseVariants,
  type Build,
  type Bundle,
  type Draft,
} from '../src/index.js';
import { describeWithBundle } from './support/bundle.js';

/** Everything JSON can hold that is not what the checkers expect. */
const JUNK: unknown[] = [null, undefined, 0, 1, 'text', true, [], [null], [[]], {}, { operatorKey: 5 }, { operatorKey: '' }];

describe('normaliseBuild', () => {
  it('a build that is complete comes back as it was, extra fields included', () => {
    const build: Build = {
      ...emptyBuild('Lifeng'),
      level: 80,
      potential: 3,
      skills: { basic: 9, battle: 10, combo: 11, ultimate: 12 },
      weaponKey: 'Aggeloslayer',
      weaponColumns: { 'Suppression [L]': 4, 'Other [M]': null },
      gear: [{ key: 'A', tier: 3 }, null, { key: 'B', tier: 0 }, null],
      talentNodes: { attribute: 2, passive: [1, 0, 2] },
    };
    expect(normaliseBuild(build)).toEqual(build);
    // A field the checker has never heard of is not lost.
    expect(normaliseBuild({ ...build, laterField: { a: 1 } })).toEqual({ ...build, laterField: { a: 1 } });
  });

  it('only the operator is needed: everything else is the empty build', () => {
    expect(normaliseBuild({ operatorKey: 'Lifeng' })).toEqual(emptyBuild('Lifeng'));
    expect(normaliseBuild({}, 'Chen Qianyu')).toEqual(emptyBuild('Chen Qianyu'));
  });

  it('a field of the wrong shape is replaced, the right ones stay', () => {
    const built = normaliseBuild({
      operatorKey: 'Lifeng',
      level: 'ninety',
      elite: Number.NaN,
      potential: 2,
      skills: { basic: 7, battle: '9', combo: null },
      weaponKey: 12,
      weaponLevel: Infinity,
      weaponColumns: [1, 2],
      gear: { 0: { key: 'A' } },
      provenance: { level: 'manual', gear: 'guessed', extra: 'profile' },
      talentNodes: { attribute: 1 },
    })!;
    expect(built.level).toBe(90);
    expect(built.elite).toBe(4);
    expect(built.potential).toBe(2);
    expect(built.skills).toEqual({ basic: 7, battle: 1, combo: 1, ultimate: 1 });
    expect(built.weaponKey).toBeNull();
    expect(built.weaponLevel).toBe(90);
    expect(built.weaponColumns).toBeUndefined();
    expect(built.gear).toEqual([null, null, null, null]);
    expect(built.provenance).toMatchObject({ level: 'manual', gear: 'default', extra: 'profile', skills: 'default' });
    expect(built.talentNodes).toBeUndefined();
  });

  it('gear is always four slots, and a slot that is not a piece is empty', () => {
    const built = normaliseBuild({
      operatorKey: 'Lifeng',
      gear: [{ key: 'A', tier: 'x' }, 5, { tier: 2 }, null, { key: 'late', tier: 1 }],
    })!;
    expect(built.gear).toEqual([{ key: 'A', tier: 0 }, null, null, null]);
  });

  it('nothing that is not an object with an operator is a build', () => {
    for (const junk of JUNK) expect(() => normaliseBuild(junk)).not.toThrow();
    expect(normaliseBuild(null)).toBeNull();
    expect(normaliseBuild([emptyBuild('A')])).toBeNull();
    expect(normaliseBuild({ level: 90 })).toBeNull();
  });
});

describe('normaliseVariants', () => {
  const good = { id: 'v1', name: 'Will', build: emptyBuild('Lifeng'), savedAt: '2026-11-01T00:00:00.000Z' };

  it('a good store is the same store', () => {
    const store = { Lifeng: { active: 'v1', variants: [good] } };
    expect(normaliseVariants(store)).toEqual(store);
  });

  it('a variant that is not one is dropped, and an active that names nothing is the showcase', () => {
    const store = {
      Lifeng: { active: 'gone', variants: [good, null, { id: 'v2' }, { id: 'v1', build: emptyBuild('Lifeng') }, 'x'] },
      Broken: { active: null, variants: 'none' },
      Empty: { active: 'a', variants: [] },
      Nothing: null,
    };
    const out = normaliseVariants(store);
    expect(Object.keys(out)).toEqual(['Lifeng']);
    expect(out.Lifeng!.variants.map((item) => item.id)).toEqual(['v1']);
    expect(out.Lifeng!.active).toBeNull();
  });

  it('a variant keeps its build, repaired, and gets a name and a date if it had none', () => {
    const out = normaliseVariants({ Lifeng: { active: 'v9', variants: [{ id: 'v9', build: { operatorKey: 'Lifeng', gear: 7 } }] } });
    const item = out.Lifeng!.variants[0]!;
    expect(item.build.gear).toEqual([null, null, null, null]);
    expect(item.name).toBe('v9');
    expect(Number.isNaN(Date.parse(item.savedAt))).toBe(false);
    expect(out.Lifeng!.active).toBe('v9');
  });

  it('a build without its operator takes the key it is stored under', () => {
    const out = normaliseVariants({ Lifeng: { active: null, variants: [{ id: 'v', name: 'n', build: { level: 50 } }] } });
    expect(out.Lifeng!.variants[0]!.build).toEqual({ ...emptyBuild('Lifeng'), level: 50 });
  });

  it('never throws', () => {
    for (const junk of JUNK) expect(() => normaliseVariants(junk)).not.toThrow();
    expect(normaliseVariants(null)).toEqual({});
  });
});

describe('normaliseDraft', () => {
  const step = { id: 's1', actor: 'Lifeng', kind: 'BS', sequence: null, optional: false, uncertain: false, note: null, cycle: 1 };
  const draft: Draft = {
    id: 'r1',
    title: 'Mine',
    team: ['Lifeng', '', 'Chen Qianyu'],
    comboPriority: ['Lifeng'],
    ultimatesCharged: true,
    controlled: 'Lifeng',
    variant: null,
    steps: [{ ...step, kind: 'BS' }, { ...step, id: 's2', kind: 'WAIT', seconds: 2 }],
    enemyKey: null,
    origin: null,
    updatedAt: '2026-11-01T00:00:00.000Z',
  };

  it('a complete draft is the same draft', () => {
    expect(normaliseDraft(draft)).toEqual(draft);
  });

  it('a draft with an id and nothing else is an empty one; a step that is not one is dropped', () => {
    const out = normaliseDraft({ id: 'r2', steps: [step, null, { id: 's9' }, { ...step, id: 's3', kind: 'NOPE' }, { ...step, id: 's4', cycle: 'x' }], team: 'a' })!;
    expect(out.team).toEqual([]);
    expect(out.steps.map((item) => item.id)).toEqual(['s1', 's4']);
    expect(out.steps[1]!.cycle).toBe(1);
    expect(out.comboPriority).toBeUndefined();
    expect(normaliseDraft({ steps: [] }, 'fallback')!.id).toBe('fallback');
  });

  it('drafts are keyed by their id and the ones that are not drafts are left out', () => {
    const out = normaliseDrafts({ r1: draft, loose: { steps: [] }, nope: 'x', nothing: null });
    expect(Object.keys(out).sort()).toEqual(['loose', 'r1']);
    expect(out.loose!.id).toBe('loose');
  });

  it('never throws', () => {
    for (const junk of JUNK) {
      expect(() => normaliseDraft(junk)).not.toThrow();
      expect(() => normaliseDrafts(junk)).not.toThrow();
    }
  });
});

describeWithBundle('a repaired build goes through the engine', (bundle: Bundle) => {
  it('every operator, from a record that has only its key, has a damage table', () => {
    const dummy = { enemyKey: null, tier: 5 as const, staggered: false, crit: false, assume: {} };
    for (const key of Object.keys(bundle.operators)) {
      const build = normaliseBuild({ operatorKey: key })!;
      expect(() => analyse(build, bundle, dummy)).not.toThrow();
    }
  });
});
