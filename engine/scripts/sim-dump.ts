/**
 * The full simulated state of every rotation, as text — for refactoring.
 *
 *     npx tsx scripts/sim-dump.ts > before.txt
 *     (change the engine)
 *     npx tsx scripts/sim-dump.ts > after.txt && diff before.txt after.txt
 *
 * Every rotation in `rotations/` × three targets (dummy, a small enemy, a
 * boss) × three duration scales, every frame: clocks, SP, energy, cooldowns,
 * target state, status events, problems and verdicts. A refactor that is
 * meant to change nothing must leave this byte-identical; one that is meant
 * to change something shows exactly what moved. The roster next to the
 * bundle is attached when present, so run both dumps with the same one.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertBundle,
  attachRoster,
  buildAliases,
  formatMessage,
  parseRot,
  reactionBonusFor,
  rosterPotential,
  simulate,
  splitVariants,
  targetFor,
  teamFromRoster,
} from '../src/index.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA = `${ROOT}app/public/data/`;
const bundle: unknown = JSON.parse(readFileSync(`${DATA}bundle.json`, 'utf8'));
assertBundle(bundle);
if (existsSync(`${DATA}roster.json`)) attachRoster(bundle, JSON.parse(readFileSync(`${DATA}roster.json`, 'utf8')));

const context = { name: (key: string) => bundle.operators[key]?.name ?? key };
const say = (message: Parameters<typeof formatMessage>[0]): string => formatMessage(message, context);
const dir = `${ROOT}rotations`;
const out: string[] = [];

for (const file of readdirSync(dir).filter((name) => name.endsWith('.rot')).sort()) {
  const rotation = parseRot(readFileSync(`${dir}/${file}`, 'utf8'), buildAliases(bundle));
  for (const enemy of [null, 'Acid Originium Slug', 'Tidalklast']) {
    const target = targetFor(bundle, enemy);
    for (const part of splitVariants(rotation.steps)) {
      const team = teamFromRoster(bundle, rotation.team, part.steps);
      const reactionBonus = reactionBonusFor(bundle, team, rosterPotential(bundle));
      for (const scale of [0.5, 1, 2]) {
        const run = simulate(part.steps, team, bundle.timings, {
          target,
          ...(bundle.sp ? { sp: bundle.sp } : {}),
          synergy: bundle.synergy,
          comboPriority: rotation.priority,
          reactionBonus,
          scale,
        });
        out.push(
          `## ${file} ${enemy} ${part.variant} x${scale} world=${run.world.toFixed(6)} ` +
            `real=${run.real.toFixed(6)} waited=${run.waited.toFixed(6)}`,
        );
        for (const wait of run.waits) out.push(`wait ${wait.step} ${wait.seconds.toFixed(6)} ${wait.reason}`);
        out.push(`sp ${run.spTimeline.map((point) => `${point.t.toFixed(4)}:${point.sp.toFixed(4)}`).join(' ')}`);
        for (const frame of run.frames) {
          out.push(
            `step ${frame.step.index} ${frame.step.actor ?? frame.step.actorRaw} ${frame.step.kind}${frame.step.sequence ?? ''} ` +
              `w=${frame.world.toFixed(6)} r=${frame.real.toFixed(6)} d=${frame.duration.toFixed(6)} ` +
              `sp=${frame.sp.toFixed(6)} rec=${frame.spRecovered} stk=${frame.stacksForHit}` +
              ` in=${frame.holds.input.toFixed(4)} ch=${frame.holds.chain.toFixed(4)}`,
          );
          out.push(`  energy ${JSON.stringify(frame.energy)} cd ${JSON.stringify(frame.cooldowns)}`);
          out.push(`  target ${JSON.stringify(frame.target)}`);
          out.push(`  status ${JSON.stringify(frame.status)} applied ${JSON.stringify(frame.applied)} combos ${JSON.stringify(frame.combos)}`);
          for (const problem of frame.problems) out.push(`  ! ${say(problem)}`);
          for (const [key, verdict] of frame.verdicts) out.push(`  v ${key} = ${say(verdict)}`);
        }
      }
    }
  }
}

console.log(out.join('\n'));
