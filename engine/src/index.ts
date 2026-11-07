/**
 * Damage calculation engine for Arknights: Endfield.
 *
 * No DOM and no network: a bundle and a build go in, numbers with a
 * breakdown come out. The same code serves the web app and the CLI, so the
 * project never gets a second implementation of the formula — two would
 * inevitably drift apart.
 *
 * Covers the damage formula, the stat sheet, timings, `.rot` parsing,
 * the resource and buff simulation, the effects layer (talents, potentials,
 * weapon and set effects placed into the formula's groups), a build's damage
 * table (`analyse`) and the track's damage sum (`trackDamage`).
 */

export * from './actions.js';
export * from './buffs.js';
export * from './build.js';
export * from './bundle.js';
export * from './curve.js';
export * from './damage.js';
export * from './draft.js';
export * from './effects.js';
export * from './grants.js';
export * from './hits.js';
export * from './messages.js';
export * from './stats.js';
export * from './timing.js';
export * from './rot.js';
export * from './showcase.js';
export * from './run.js';
export * from './status.js';
export * from './statusHits.js';
export * from './trackDamage.js';
export * from './triggers.js';
export * from './simulate.js';
export * from './talents.js';
