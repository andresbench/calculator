/**
 * Rotation draft: edits, round trip and palette.
 *
 * The main test here is the **round trip over the real files**. Each file in
 * `rotations/` and `rotations/archive/` is copied into a draft, serialised
 * back to `.rot` and parsed again; the steps must match. The archive is no
 * longer played (its timing predates the measurements of 2026-11-06), but it
 * is the widest sample of the notation there is. An export that silently drops a step is
 * worse than none: the user learns of the loss from a file that has been in
 * the repository for a week.
 *
 * The rotations are played as written, so a mismatch here is a
 * serialisation bug, not a reason to edit the file (the same rule as in
 * `rotations-real.test.ts`).
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  addStep,
  buildAliases,
  checkRoundTrip,
  draftFromRotation,
  draftsFromText,
  draftSteps,
  draftToText,
  emptyDraft,
  moveStep,
  normalise,
  parseRot,
  patchStep,
  removeStep,
  setTeam,
  type Bundle,
  type Draft,
} from '../src/index.js';
import { bundle, describeWithBundle } from './support/bundle.js';


function draftWith(steps: Array<[string, Draft['steps'][number]['kind'], number | null]>): Draft {
  let draft = setTeam(emptyDraft(), [...new Set(steps.map(([actor]) => actor))]);
  for (const [actor, kind, sequence] of steps) {
    draft = addStep(draft, {
      actor,
      kind,
      sequence,
      optional: false,
      uncertain: false,
      note: null,
      cycle: 1,
    });
  }
  return draft;
}

/** `.rot` files of the repository: the played ones and the archive. */
function rotationFiles(): Array<[string, { name: string; text: string }]> {
  const root = fileURLToPath(new URL('../../rotations/', import.meta.url));
  return ['', 'archive/'].flatMap((folder) =>
    existsSync(root + folder)
      ? readdirSync(root + folder)
          .filter((name) => name.endsWith('.rot'))
          .sort()
          .map((name): [string, { name: string; text: string }] => {
            const stem = name.slice(0, -4);
            return [folder + stem, { name: folder + stem, text: readFileSync(root + folder + name, 'utf8') }];
          })
      : [],
  );
}

describeWithBundle('round trip over the real rotations', () => {
  const files = rotationFiles();

  it('there are files at all', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const [key, file] of files) {
    it(`${file.name}: draft → text → the same steps`, () => {
      const rotation = parseRot(file.text, buildAliases(bundle!));
      const variants = rotation.variants.length > 0 ? rotation.variants : [null];
      for (const variant of variants) {
        const draft = draftFromRotation(rotation, variant, key);
        const text = draftToText(bundle!, draft);
        const check = checkRoundTrip(bundle!, draft, text);
        expect(check.problems, `${file.name} / ${variant ?? 'no variant'}`).toEqual([]);
      }
    });
  }

  it('one variant is taken, not all glued together', () => {
    // Variants are different ways to play: each has its own fresh target and
    // cooldowns. Glued into one sequence they would make a rotation nobody
    // plays.
    const multi = files.find(([, file]) => parseRot(file.text).variants.length > 1);
    expect(multi, 'needs a file with several variants').toBeTruthy();
    const rotation = parseRot(multi![1].text, buildAliases(bundle!));
    const first = draftFromRotation(rotation, rotation.variants[0]!, 'x');
    expect(first.steps.length).toBeLessThan(rotation.steps.length);
    expect(first.variant).toBe(rotation.variants[0]);
  });

  it('cycles and notes survive the export', () => {
    const rotation = parseRot(files[0]![1].text, buildAliases(bundle!));
    const draft = draftFromRotation(rotation, rotation.variants[0] ?? null, 'x');
    const withNote = patchStep(draft, draft.steps[0]!.id, { note: 'check', cycle: 3 });
    const back = parseRot(draftToText(bundle!, withNote), buildAliases(bundle!));
    expect(back.steps[0]!.note).toBe('check');
    expect(back.steps[0]!.cycle).toBe(3);
  });
});

describeWithBundle('import from text', () => {
  it('every repository file imports, one draft per variant, and exports back the same', () => {
    for (const file of Object.values(bundle!.rotations ?? {})) {
      const { drafts, problems } = draftsFromText(bundle!, file.text, file.name);
      const variants = parseRot(file.text).variants;
      expect(problems.filter((problem) => problem.code.startsWith('import')), file.name).toEqual([]);
      expect(drafts.length, file.name).toBe(Math.max(1, variants.length));
      for (const draft of drafts) {
        expect(draft.origin).toBeNull();
        expect(checkRoundTrip(bundle!, draft, draftToText(bundle!, draft)).problems, file.name).toEqual([]);
      }
    }
  });

  it('an unknown operator stops the import instead of guessing', () => {
    const result = draftsFromText(bundle!, 'team: Lifeng, Nobody\nLifeng: BS\nNobody: CS\n', 'x');
    expect(result.drafts).toEqual([]);
    expect(result.problems.map((problem) => problem.code)).toContain('importUnknownOperator');
  });

  it('holes keep their slots, and an actor missing from team: takes the first hole', () => {
    const { drafts } = draftsFromText(bundle!, 'team: Lifeng, -, -, Chen Qianyu\nPogranichnik: BS\n', 'x');
    expect(drafts[0]!.team).toEqual(['Lifeng', 'Pogranichnik', '', 'Chen Qianyu']);
  });

  it('five operators do not fit in a team', () => {
    const text = 'team: Lifeng, Chen Qianyu, Pogranichnik, Mi Fu\nRossi: CS\n';
    expect(draftsFromText(bundle!, text, 'x').problems.map((problem) => problem.code)).toEqual(['importTeamSize']);
  });

  it('empty text is nothing to import; a title without one falls back', () => {
    expect(draftsFromText(bundle!, '# just a comment\n', 'x').problems.map((problem) => problem.code)).toEqual([
      'importEmpty',
    ]);
    expect(draftsFromText(bundle!, 'Lifeng: BS\n', 'Pasted').drafts[0]!.title).toBe('Pasted');
  });
});

describeWithBundle('draft edits', () => {
  it('adding puts the step at the given position', () => {
    let draft = draftWith([
      ['Chen Qianyu', 'BS', null],
      ['Chen Qianyu', 'CS', null],
    ]);
    draft = addStep(
      draft,
      { actor: 'Chen Qianyu', kind: 'ULT', sequence: null, optional: false, uncertain: false, note: null, cycle: 1 },
      1,
    );
    expect(draft.steps.map((step) => step.kind)).toEqual(['BS', 'ULT', 'CS']);
  });

  it('moving neither loses nor duplicates steps', () => {
    const draft = draftWith([
      ['Chen Qianyu', 'BS', null],
      ['Chen Qianyu', 'CS', null],
      ['Chen Qianyu', 'ULT', null],
    ]);
    const moved = moveStep(draft, draft.steps[2]!.id, 0);
    expect(moved.steps.map((step) => step.kind)).toEqual(['ULT', 'BS', 'CS']);
    expect(moved.steps).toHaveLength(3);
    expect(new Set(moved.steps.map((step) => step.id)).size).toBe(3);

    // Moving past the end of the list clamps to the edge instead of dropping the step.
    const far = moveStep(draft, draft.steps[0]!.id, 99);
    expect(far.steps.map((step) => step.kind)).toEqual(['CS', 'ULT', 'BS']);
  });

  it('removing an operator takes their steps along', () => {
    // Otherwise the actions of someone not in the team would remain, and the
    // simulation would flag them as errors with no visible cause.
    const draft = draftWith([
      ['Chen Qianyu', 'BS', null],
      ['Mi Fu', 'CS', null],
    ]);
    const trimmed = setTeam(draft, ['Chen Qianyu']);
    expect(trimmed.steps.map((step) => step.actor)).toEqual(['Chen Qianyu']);
  });

  it('removing a step leaves the rest alone', () => {
    const draft = draftWith([
      ['Chen Qianyu', 'BS', null],
      ['Chen Qianyu', 'CS', null],
    ]);
    const left = removeStep(draft, draft.steps[0]!.id);
    expect(left.steps).toHaveLength(1);
    expect(left.steps[0]!.kind).toBe('CS');
  });

  it('steps are numbered from one — verdicts refer to these numbers', () => {
    const draft = draftWith([
      ['Chen Qianyu', 'BS', null],
      ['Chen Qianyu', 'CS', null],
    ]);
    expect(draftSteps(draft).map((step) => step.index)).toEqual([1, 2]);
  });

  it('an empty draft exports without crashing', () => {
    const draft = emptyDraft();
    const text = draftToText(bundle!, draft);
    expect(text).toContain('title:');
    expect(checkRoundTrip(bundle!, draft, text).ok).toBe(true);
  });
});

describeWithBundle('name resolution is unambiguous', () => {
  it('the same name on two keys resolves the same way on every path', () => {
    // The wiki has two Endministrators, male and female, with one name.
    // While the name overwrote itself and an alias took the first match, a
    // rotation run through formatRot and parsed back changed the operator's
    // gender. The round trip over `endmin-core` caught it.
    const aliases = buildAliases(bundle!);
    const twins = Object.values(bundle!.operators).filter((operator) =>
      operator.key.startsWith('Endministrator'),
    );
    expect(twins.length).toBe(2);
    const byName = aliases.get('endministrator');
    const byAlias = aliases.get('эндмин'); // a Russian alias from roster/aliases.yaml
    expect(byName).toBe(byAlias);
    // The first by sorted key wins — the choice does not depend on the order
    // of fields in the bundle.
    expect(byName).toBe(twins.map((operator) => operator.key).sort()[0]);
  });

  it('an exact key beats an alias', () => {
    const aliases = buildAliases(bundle!);
    for (const key of Object.keys(bundle!.operators)) {
      expect(aliases.get(normalise(key)), key).toBe(key);
    }
  });
});
