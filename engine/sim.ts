#!/usr/bin/env -S npx tsx
/**
 * Checks a rotation with the engine: `npm run sim -- rotations/breach-core.rot`
 *
 * Prints per variant: duration, what it is made of, waits, problems, the
 * damage and DPS the app's track shows, and the list of verdicts that depend
 * on unmeasured action durations. `--caveats` lists what the damage sum
 * leaves out; `--dummy Boss` plays the dummy with a typical boss's stagger
 * meter instead of none.
 *
 * The waits here are not a stub but derived time. The `.rot` notation
 * records the order of significant actions, not every button press, so
 * there is unrecorded idle time between steps. Cooldowns and SP regen are
 * wiki data, and the engine computes from them how long it had to wait. The
 * larger the waiting share, the less the result depends on the nominal
 * second.
 */

import { readFileSync } from 'node:fs';

import {
  buildAliases,
  ENEMY_CLASSES,
  formatMessage,
  openedBy,
  parseRot,
  reactionBonusFor,
  simModifiersFor,
  rosterPotential,
  showcaseBuild,
  simulateVariant,
  splitVariants,
  targetFor,
  teamFromRoster,
  trackDamage,
  type Bundle,
} from './src/index.js';

import { loadBundle } from './load.js';


function main(): void {
  const args = process.argv.slice(2);
  const file = args.find((arg) => !arg.startsWith('--'));
  const enemyIndex = args.indexOf('--enemy');
  const enemyName = enemyIndex >= 0 ? args[enemyIndex + 1] : undefined;
  const caveats = args.includes('--caveats');
  const dummyIndex = args.indexOf('--dummy');
  const dummyClass = dummyIndex >= 0 ? (args[dummyIndex + 1] ?? null) : null;
  if (!file) {
    console.error('Give a file: npm run sim -- rotations/breach-core.rot [--enemy "Name" | --dummy Boss] [--caveats]');
    process.exit(1);
  }

  const bundle = loadBundle();
  if (enemyName && !bundle.enemies[enemyName]) {
    console.error(`No enemy "${enemyName}" in the database.`);
    process.exit(1);
  }
  if (dummyClass && !(ENEMY_CLASSES as readonly string[]).includes(dummyClass)) {
    console.error(`No enemy class "${dummyClass}": ${ENEMY_CLASSES.join(', ')}.`);
    process.exit(1);
  }
  const target = targetFor(bundle, enemyName, dummyClass);
  const context = { name: (key: string) => bundle.operators[key]?.name ?? key };
  const say = (message: Parameters<typeof formatMessage>[0] | undefined): string =>
    message ? formatMessage(message, context) : 'undefined';
  const rotation = parseRot(readFileSync(file, 'utf8'), buildAliases(bundle));

  // The order of `team:` is squad position: the game reads it (see TeamMember).
  const team = teamFromRoster(bundle, rotation.team, rotation.steps);

  console.log(rotation.title ?? file);
  console.log(`${rotation.steps.length} steps, team of ${team.size}`);
  console.log(
    target.staggerMeter == null
      ? 'target: dummy, no stagger meter (a finisher cannot be evaluated)'
      : `target: ${target.name}, Stagger HP ${target.staggerMeter}, ` +
          `finisher x${target.finisherMultiplier} and +${target.finisherSp} SP`,
  );
  const basics = Object.values(bundle.sp?.basicAttack ?? {});
  const uncertain = basics.filter((row) => row.uncertain).length;
  console.log(
    basics.length > 0
      ? `timing: chains, skill windows and hits from the client (${basics.length} operators, ${uncertain} ` +
          'uncertain chains); a press comes as soon as it is allowed, other operators in parallel'
      : 'action durations are not measured: see data/endfield/timings.yaml',
  );
  for (const warning of rotation.warnings) console.log(`  ! ${say(warning)}`);

  for (const part of splitVariants(rotation.steps)) {
    const team = teamFromRoster(bundle, rotation.team, part.steps);
    const { result: base, fragile, passes } = simulateVariant(bundle, part.steps, team, {
      target,
      priority: rotation.priority,
      controlled: rotation.controlled ?? null,
      // The rotation's own `ultimates:` and `sp:` lines, as the app reads them.
      ultimatesCharged: rotation.ultimatesCharged ?? false,
      unlimitedSp: rotation.unlimitedSp ?? false,
      reactionBonus: reactionBonusFor(bundle, team, rosterPotential(bundle)),
      modifiers: simModifiersFor(bundle, team, rosterPotential(bundle), (key) => showcaseBuild(key, bundle)),
    });

    const share = (100 * base.waited) / Math.max(base.real, 0.001);
    console.log(`\n-- variant: ${part.variant ?? 'none'} --`);
    console.log(
      `   ${part.steps.length} steps, ${base.real.toFixed(1)} s, ` +
        `of which ${base.waited.toFixed(1)} s waiting (${share.toFixed(0)} %)`,
    );
    // The same sum the app's track shows, on the roster's builds.
    const damage = trackDamage(
      bundle,
      { frames: base.frames, length: base.real, team: [...team.keys()], target },
      (key) => showcaseBuild(key, bundle),
      enemyName ?? null,
    );
    const shares = damage.byOperator
      .filter((row) => row.damage > 0)
      .map((row) => `${context.name(row.key)} ${((100 * row.damage) / Math.max(damage.total, 1)).toFixed(0)} %`);
    console.log(
      `   damage ${Math.round(damage.total).toLocaleString('en-US')}, ` +
        `DPS ${Math.round(damage.dps).toLocaleString('en-US')} (crit averaged; ` +
        `${bundle.roster ? 'builds from the roster' : 'no roster: starter builds — skills 9, a 4★ weapon, AIC Fieldwork'})`,
    );
    if (shares.length > 0) console.log(`   by operator: ${shares.join(', ')}`);
    if (caveats) {
      console.log(`   not counted (${damage.notCounted.length}):`);
      for (const item of damage.notCounted) {
        console.log(`     ${item.operator ? `${context.name(item.operator)}: ` : ''}${say(item.message)}`);
      }
    } else {
      console.log(`   not counted: ${damage.notCounted.length} caveats (--caveats lists them)`);
    }

    for (const frame of base.frames) {
      const actor = frame.step.actor ?? frame.step.actorRaw;
      const action = `${frame.step.kind}${frame.step.sequence ?? ''}`;
      const line =
        `   ${frame.world.toFixed(1).padStart(5)} s  ${actor.padEnd(16)} ${action.padEnd(5)}` +
        `  SP ${String(Math.floor(frame.sp)).padStart(3)}`;
      const trigger = frame.verdicts.get(`${frame.step.index}:trigger`);
      const applies = frame.verdicts.get(`${frame.step.index}:applies`);
      const tail =
        frame.problems.length > 0
          ? `   ← ${frame.problems.map(say).join('; ')}`
          : openedBy(trigger)
            ? `   opened by: ${say(trigger)}`
            : applies
              ? `   applies: ${say(applies)}`
              : '';
      console.log(line + tail);
    }

    if (base.waits.length > 0) {
      console.log('   waiting:');
      for (const wait of base.waits) {
        console.log(`     step ${wait.step}: +${wait.seconds.toFixed(1)} s — ${wait.reason}`);
      }
    }

    if (fragile.length > 0) {
      console.log(`   depend on the unmeasured action duration (${fragile.length}):`);
      for (const key of fragile) {
        const detail = passes.map((pass) => `×${pass.scale}→${say(pass.verdicts.get(key))}`).join(', ');
        console.log(`     ${key}: ${detail}`);
      }
    } else {
      console.log('   every verdict survives scaling the action durations');
    }
  }
}

main();
