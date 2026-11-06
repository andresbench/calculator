/**
 * The six rotations the user actually plays, run through the engine.
 *
 * This is the acceptance test for stage E3: the plan says the track UI must
 * not be built until the engine reproduces these files, because otherwise
 * the interface would be drawing wrong windows very prettily.
 *
 * It needs a built bundle, which is generated and not under version control,
 * so it skips itself when the bundle is missing rather than inventing a pass.
 * Build it with `python3 tools/ef/export.py`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildAliases,
  formatMessage,
  parseRot,
  reactionBonusFor,
  simulateVariant,
  splitVariants,
} from '../src/index.js';

import { PLAYED } from './fixtures/played-builds.js';
import { describeWithBundle, teamOf } from './support/bundle.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ROTATIONS = `${ROOT}rotations`;

describeWithBundle('the rotations in rotations/', (data) => {
  // The same aliases the app and the CLI use: `bundle.aliases`.
  const aliases = buildAliases(data);
  const files = existsSync(ROTATIONS)
    ? readdirSync(ROTATIONS).filter((name) => name.endsWith('.rot'))
    : [];

  it('there are rotation files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const rotation = parseRot(readFileSync(`${ROTATIONS}/${file}`, 'utf8'), aliases);

      it('every operator is recognised', () => {
        const unknown = rotation.steps.filter((step) => step.actor === null);
        expect(unknown.map((step) => step.actorRaw)).toEqual([]);
      });

      it('every combo skill is opened by something earlier in the chain', () => {
        const complaints: string[] = [];
        for (const part of splitVariants(rotation.steps)) {
          // The very path the app's track and `npm run sim` take.
          const team = teamOf(data, rotation.team, part.steps, PLAYED);
          const { result } = simulateVariant(data, part.steps, team, {
            priority: rotation.priority,
            reactionBonus: reactionBonusFor(data, team, (key) => PLAYED[key]?.potential ?? 0),
          });
          for (const frame of result.frames) {
            for (const problem of frame.problems) {
              // The game sets the order of simultaneous combos: a rotation
              // written against the priority does not play that way.
              if (problem.code === 'triggerMissing' || problem.code === 'comboOutOfOrder') {
                complaints.push(`${part.variant ?? '—'} step ${frame.step.index}: ${formatMessage(problem)}`);
              }
            }
          }
        }
        // These rotations are played in game, so a complaint here means the
        // model is wrong, not the rotation.
        expect(complaints).toEqual([]);
      });
    });
  }
});
