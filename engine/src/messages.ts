/**
 * What the simulation says about a step: problems and verdicts, as data.
 *
 * The engine never builds sentences. It emits a `Message` — a code and its
 * parameters — and a catalog turns that into text. The English catalog lives
 * here so the CLI prints the same words as the app; other languages add a
 * catalog of the same type, and TypeScript refuses one that misses a code.
 *
 * Operators are passed by key, not by name: the catalog asks `names` for the
 * name to show, so a translated interface shows translated names. Game terms
 * ("Cryo Infliction") and skill names stay as the wiki spells them; a
 * catalog may translate them on its own.
 */

import type { ArtsElement } from './status.js';
import type { SkillType } from './bundle.js';

export type Message =
  // --- problems: the step does not work as written ---
  | { code: 'notInTeam'; actor: string }
  | { code: 'noSkill'; operator: string; skill: SkillType }
  | { code: 'deferredExpired'; operator: string; skill: string; step: number }
  | { code: 'ultimateNotCharged'; needs: number; has: number }
  | { code: 'triggerMissing'; terms: Array<{ term: string; min?: number }>; consumed: boolean }
  | { code: 'triggerBlocked'; terms: string[] }
  | { code: 'triggerOutOfStance'; operator: string; stance: string }
  | { code: 'comboOutOfOrder'; operator: string; other: string; otherStep: number }
  /** Pressed `seconds` after its trigger, and a combo stays ready only `ready` (#65). */
  | { code: 'comboExpired'; seconds: number; ready: number }
  /** Its trigger came `seconds` before the cooldown ended: nothing lit it (#72). */
  | { code: 'comboTriggerOnCooldown'; seconds: number }
  | { code: 'finisherNoMeter' }
  | { code: 'finisherNotStaggered'; stagger: number; meter: number }
  // --- verdicts: what the engine concluded about the step ---
  | { code: 'secondPhase'; to: string }
  | { code: 'inflictionExpired'; element: ArtsElement }
  | { code: 'spEnough' }
  | { code: 'spWaiting' }
  | { code: 'energyCharged' }
  | { code: 'energyNotCharged' }
  | { code: 'cooldownCutEmptySlot'; slot: number }
  | { code: 'cooldownCut'; operator: string; slot: number; seconds: number; was: number; now: number }
  | { code: 'cooldownCutWasted'; operator: string; slot: number; seconds: number }
  | { code: 'cooldownReady' }
  /** A combo written before its cooldown ends: the press waits `seconds` for it. */
  | { code: 'comboOnCooldown'; seconds: number }
  /** A combo's slowdown: everyone but its caster stands still `seconds` (#64). */
  | { code: 'comboSlowsWorld'; seconds: number }
  | { code: 'comboWentDark'; seconds: number; ready: number }
  | { code: 'triggerNotOpen' }
  | { code: 'triggerUnread'; own?: string }
  | { code: 'triggerOpenedBy'; by: Array<{ term: string; step: number }> }
  | { code: 'priorityOutOfOrder' }
  | { code: 'priorityInOrder'; after: number }
  | { code: 'finalStrikeSp'; sp: number }
  | { code: 'staggerNode'; share: number }
  | { code: 'stanceEntered'; stance: string; until: number }
  | { code: 'chargesGained'; term: string; points: number; until: number | null }
  | { code: 'transformGained'; move: string; until: number | null }
  | { code: 'detonated'; name: string; step: number }
  | { code: 'echoed'; elements: string[]; min: number }
  | { code: 'strikeAfter'; talent: string }
  | { code: 'goneBeforeStrike'; term: string; until: number }
  | { code: 'barrage'; shots: number; seconds: number }
  | { code: 'stockGained'; term: string; count: number }
  | { code: 'stockSpent'; term: string; spent: number; makes: string; made: number; sp: number }
  | { code: 'transformedCast'; move: string; as: SkillType }
  | { code: 'enhancedBasicGained'; move: string; until: number }
  | { code: 'enhancedBasicPaused'; move: string; until: number }
  | { code: 'enhancedBasicCast'; move: string }
  | { code: 'duringUltimateCast'; ultimate: string }
  | { code: 'ownStacksShort'; term: string; have: number; need: number }
  | { code: 'ownStacksSpent'; term: string; spent: number; energy: number }
  | { code: 'ownStacksGained'; operator: string; term: string; count: number }
  | { code: 'ownStacksAbsorbed'; operator: string; term: string; absorbed: number; talent: string }
  | { code: 'chargeSpent'; operator: string; term: string; left: number; sp: number }
  | { code: 'finisherReady' }
  | { code: 'finisherNotReady' }
  | { code: 'targetStaggered' }
  | { code: 'slotSwap'; term: string; alt: string; slot: number; operator: string; element: string }
  | { code: 'slotKeep'; term: string; slot: number; element: string }
  | { code: 'grantWithheld'; term: string; has?: string; lacks?: string }
  | { code: 'grantArmed'; term: string; times: number; until: number | null }
  | { code: 'grantOnStrike'; term: string; operator: string; left: number }
  | { code: 'shatter' }
  | { code: 'statusLevel'; level: number }
  | { code: 'reaction'; element: ArtsElement; standing: ArtsElement; consumed: number; reaction: string }
  | { code: 'burst'; element: ArtsElement; stack: number }
  | { code: 'reactionForced'; term: string }
  | { code: 'consumed'; items: Array<{ term: string; count?: number }> }
  | { code: 'deferred'; window: number | null }
  | { code: 'delivers'; operator: string; skill: string }
  | { code: 'landsLater'; seconds: number }
  | { code: 'landsHere'; operator: string; skill: string; step: number }
  | { code: 'waitsForHit'; operator: string; seconds: number }
  /** A combo opened by a Final Strike waits for the strike's hit, not its press. */
  | { code: 'waitsForStrike'; operator: string; seconds: number }
  /** A combo opened by another combo: it lights up on that combo's hit (#66). */
  | { code: 'waitsForComboHit'; operator: string; seconds: number }
  | { code: 'applies'; terms: string[] }
  | { code: 'debuffActive'; until: number | null }
  | { code: 'spRecovered'; sp: number }
  | { code: 'spRecoveredFor'; operator: string; skill: string; sp: number }
  | { code: 'spReturned'; sp: number; term: string }
  | { code: 'stagesAreHits'; written: number }
  | { code: 'movesByStacks'; moves: number; stacks: number; enhanced: boolean }
  | { code: 'linkSpent'; count: number; bonus: number }
  | { code: 'crystalsShattered'; owner: string; by: string }
  | { code: 'perfectDodge'; sp: number; pause: number }
  | { code: 'skillWindow'; kind: 'BS' | 'CS' | 'ULT'; seconds: number; measured: boolean }
  | { code: 'cutsceneRegen'; seconds: number }
  | { code: 'markStacks'; mark: string; stacks: number }
  | { code: 'vulnerableAdded'; count: number; stacks: number }
  | { code: 'markDetonated'; mark: string; stacks: number; boost: number }
  | { code: 'pause'; seconds: number }
  // --- reading a .rot file and checking a draft ---
  | { code: 'rotUnparsed'; line: number; token: string }
  | { code: 'rotNoActor'; line: number; token: string }
  | { code: 'rotNoAction'; line: number }
  | { code: 'rotUnknownOperator'; step: number; actor: string }
  | { code: 'draftStepCount'; before: number; after: number }
  | { code: 'draftStepChanged'; step: number; was: string; now: string }
  | { code: 'importUnknownOperator'; actor: string }
  | { code: 'importEmpty' }
  | { code: 'importTeamSize'; count: number }
  | { code: 'importBadLink' }
  // --- the stat sheet ---
  | { code: 'statsNoCurve'; stat: string }
  | { code: 'statsNoWeaponAtk'; weapon: string }
  | { code: 'statsNoWeapon' }
  | { code: 'statsGearStatUnparsed'; stat: string; piece: string }
  | { code: 'statsNoGear' }
  | { code: 'statsTooMuchGear'; count: number }
  // --- the damage formula: why a factor is what it is, and what was left out ---
  | { code: 'evAttack' }
  | { code: 'evDmgBonus' }
  | { code: 'evStaggered' }
  | { code: 'evWeaken' }
  | { code: 'evDmgTaken' }
  | { code: 'evProtect' }
  | { code: 'evDefense' }
  | { code: 'evResistConfirmed' }
  | { code: 'evResistInferred' }
  | { code: 'evLevelPhysical' }
  | { code: 'evLevel' }
  | { code: 'evArtsIntensity' }
  | { code: 'noteDotNoCrit' }
  | { code: 'noteNoLevel' }
  | { code: 'noteArtsIntensityIgnored' }
  // --- buffs on the track the dummy cannot model ---
  | { code: 'buffNoTrigger'; effect: string }
  | { code: 'buffAssumed'; effect: string; condition: string }
  | { code: 'buffNoDuration'; effect: string }
  | { code: 'buffCritUntracked'; effect: string }
  | { code: 'buffCritExpected'; effect: string }
  | { code: 'buffNeverOnDummy'; effect: string; trigger: string }
  | { code: 'buffTriggerUntracked'; effect: string; trigger: string }
  // --- what a build's damage table leaves out (`analyse`) ---
  | { code: 'noLayout'; operator: string; talents: number }
  | { code: 'unmodeled'; where: string; text: string }
  | { code: 'staleLayout'; effect: string }
  | { code: 'weaponNoLayout'; weapon: string; component: string }
  | { code: 'setNoLayout'; set: string }
  // --- what the track's damage sum leaves out (`trackDamage`) ---
  | { code: 'trackCorrosion' }
  | { code: 'trackLink' }
  | { code: 'trackNextStep' }
  /** Hits land at their own time only against a later press; inside their own step they take the press's buffs. */
  | { code: 'trackHitTimes' }
  /** The wiki's rows and the client's hits disagree: every row of the skill lands on its last hit. */
  | { code: 'trackHitGuess'; operator: string; skill: string }
  | { code: 'trackStatusSnapshot' }
  | { code: 'trackStaggerAtStart' }
  | { code: 'trackGrantSnapshot' }
  | { code: 'trackGrantUncounted'; rows: Array<{ operator: string; term: string; reason: 'chance' | 'single' }> }
  | { code: 'trackNoLayout'; operator: string }
  | { code: 'trackConditional'; rows: Array<{ operator: string; label: string }> }
  | { code: 'trackHitCount'; rows: Array<{ operator: string; label: string }> }
  | { code: 'trackBarrage'; operator: string }
  | { code: 'trackFuse'; operator: string; name: string; fuse: number | null };

export type MessageCode = Message['code'];

export interface MessageContext {
  /** Display name of an operator by key. */
  name: (key: string) => string;
}

/** One function per code, each getting exactly its own message. */
export type Catalog = {
  [C in MessageCode]: (message: Extract<Message, { code: C }>, context: MessageContext) => string;
};

/** "Chen Qianyu: Slash Multiplier; Rossi: …" — skill rows by operator. */
export const rowList = (rows: Array<{ operator: string; label: string }>, context: MessageContext): string =>
  rows.map((row) => `${context.name(row.operator)}: ${row.label}`).join('; ');

const slotLabel = (slot: number): string => `slot ${String(slot).padStart(2, '0')}`;

export const EN_MESSAGES: Catalog = {
  notInTeam: (m) => `not in the team: ${m.actor}`,
  noSkill: (m, c) => `${c.name(m.operator)} has no ${m.skill}`,
  deferredExpired: (m, c) =>
    `${c.name(m.operator)}'s ${m.skill} (step ${m.step}) expired: no Final Strike within its duration`,
  ultimateNotCharged: (m) => `ultimate not charged: needs ${m.needs}, has ${m.has.toFixed(1)}`,
  triggerMissing: (m) =>
    `trigger needs ${m.terms.map((item) => `"${item.term}"${item.min ? ` ×${item.min}` : ''}`).join(' or ')}` +
    `${m.consumed ? ' consumed' : ''}, but the target does not have it at this point`,
  triggerBlocked: (m) =>
    `trigger needs a target without ${m.terms.map((term) => `"${term}"`).join(' or ')}, but it is on the target at this point`,
  triggerOutOfStance: (m, c) => `trigger works only in ${m.stance}, and ${c.name(m.operator)} is not in it at this point`,
  comboOutOfOrder: (m, c) =>
    `triggered together with ${c.name(m.other)}'s combo (step ${m.otherStep}), but ` +
    `${c.name(m.operator)} is higher in combo priority, so the game casts it first — ` +
    'swap the steps or change the priority',
  comboExpired: (m) =>
    `pressed ${m.seconds.toFixed(1)} s after its trigger, but a combo stays ready only ${m.ready} s — ` +
    'it is not there to press',
  comboTriggerOnCooldown: (m) =>
    `its trigger came ${m.seconds.toFixed(1)} s before the cooldown ended — while the button is grey, nothing lights it`,
  finisherNoMeter: () => 'a finisher needs a staggered target, and no stagger meter is set — pick an enemy',
  finisherNotStaggered: (m) => `a finisher needs a staggered target: ${m.stagger.toFixed(0)} of ${m.meter}`,

  secondPhase: (m) => `${m.to}: second phase, no energy cost`,
  inflictionExpired: (m) => `${m.element} Infliction expired`,
  spEnough: () => 'enough',
  spWaiting: () => 'waiting',
  energyCharged: () => 'charged',
  energyNotCharged: () => 'not charged',
  cooldownCutEmptySlot: (m) => `${slotLabel(m.slot)} is empty`,
  cooldownCut: (m, c) =>
    `${c.name(m.operator)} (${slotLabel(m.slot)}) combo −${m.seconds} s: ready at ${m.was.toFixed(1)} → ${m.now.toFixed(1)} s`,
  cooldownCutWasted: (m, c) =>
    `${c.name(m.operator)} (${slotLabel(m.slot)}) combo was not on cooldown — −${m.seconds} s wasted`,
  cooldownReady: () => 'ready',
  comboOnCooldown: (m) => `on cooldown: waits ${m.seconds.toFixed(1)} s`,
  comboSlowsWorld: (m) => `slows the world: everyone else stands still ${m.seconds.toFixed(2)} s`,
  comboWentDark: (m) => `went dark ${(m.seconds - m.ready).toFixed(1)} s before the press`,
  triggerNotOpen: () => 'not open',
  triggerUnread: (m) =>
    m.own ? `trigger not checked: the engine does not count ${m.own}s` : 'trigger not checked: the track does not see this event',
  triggerOpenedBy: (m) => m.by.map((hit) => `${hit.term} (step ${hit.step})`).join(', '),
  priorityOutOfOrder: () => 'out of order',
  priorityInOrder: (m) => `in order after step ${m.after}`,
  finalStrikeSp: (m) => `+${m.sp} SP`,
  finisherReady: () => 'target staggered',
  finisherNotReady: () => 'target NOT staggered',
  targetStaggered: () => 'target staggered',
  stanceEntered: (m) => `${m.stance} until ${m.until.toFixed(1)} s`,
  grantArmed: (m) =>
    `${m.term} on the next ${m.times} Final Strikes of the controlled operator${m.until == null ? '' : ` until ${m.until.toFixed(1)} s`}`,
  grantOnStrike: (m, c) => `${c.name(m.operator)}'s ${m.term} on this Final Strike: ${m.left} left`,
  grantWithheld: (m) =>
    m.has != null ? `${m.term} not applied: no ${m.has} on the target` : `${m.term} not applied: the target has ${m.lacks ?? ''}`,
  stockGained: (m) => `${m.term}: ${m.count} on the field`,
  stockSpent: (m) =>
    `takes ${m.spent} ${m.term}: ${m.made} ${m.makes}${m.sp > 0 ? `, +${m.sp} SP returned` : ''}`,
  transformGained: (m) => `the battle skill becomes ${m.move}${m.until == null ? '' : ` until ${m.until.toFixed(1)} s`}`,
  transformedCast: (m) => `${m.move}: treated as a ${m.as}`,
  enhancedBasicGained: (m) => `basic attacks become ${m.move} until ${m.until.toFixed(1)} s`,
  enhancedBasicPaused: (m) => `${m.move} window paused by the cast: now until ${m.until.toFixed(1)} s`,
  enhancedBasicCast: (m) => `${m.move}: the ultimate's chain, Basic Attack DMG`,
  duringUltimateCast: (m) => `the battle skill inside ${m.ultimate}: its «During Ultimate» strikes`,
  ownStacksShort: (m) => `${m.have} of ${m.need} ${m.term}: no extra attack`,
  ownStacksSpent: (m) => `spends ${m.spent} ${m.term}: extra attack${m.energy > 0 ? `, +${m.energy} ultimate energy` : ''}`,
  ownStacksGained: (m, ctx) => `${ctx.name(m.operator)}: ${m.term} ${m.count}`,
  ownStacksAbsorbed: (m, ctx) => `${ctx.name(m.operator)} absorbs ${m.absorbed} ${m.term} (${m.talent})`,
  goneBeforeStrike: (m) => `${m.term} ends at ${m.until.toFixed(1)} s, before the closing strike: not consumed`,
  strikeAfter: (m) => `${m.talent}: this basic attack is a Final Strike — one hit`,
  echoed: (m) =>
    m.elements.length > 0
      ? `repeats ${m.elements.map((element) => `${element} Infliction`).join(', ')}: already on the target`
      : `repeats nothing: no ${m.min > 1 ? `${m.min}+ stacks of ` : ''}its elements on the target`,
  detonated: (m) => `sets off the ${m.name} from step ${m.step}: its explosion lands here, stronger`,
  barrage: (m) => `the whole window: ${m.shots} shots, then the closing strike — ${m.seconds.toFixed(1)} s`,
  chargesGained: (m) => `${m.points} ${m.term}${m.until == null ? '' : ` until ${m.until.toFixed(1)} s`}`,
  chargeSpent: (m, c) =>
    `${c.name(m.operator)} spends 1 ${m.term}: ${m.left} left${m.sp > 0 ? `, +${m.sp} SP` : ''}`,
  staggerNode: (m) => `Stagger Node at ${Math.round(m.share * 100)} % of the meter`,
  slotSwap: (m, c) =>
    `${m.alt} instead of ${m.term}: ${slotLabel(m.slot)} is ${c.name(m.operator)} (${m.element})`,
  slotKeep: (m) => `${m.term}: ${slotLabel(m.slot)} is not ${m.element}`,
  shatter: () => 'Solidification consumed → Shatter',
  statusLevel: (m) => String(m.level),
  reaction: (m) =>
    `${m.element} on ${m.consumed}× ${m.standing} → ${m.reaction}, Status Level ${m.consumed}`,
  burst: (m) => `${m.element} Burst (stack ${m.stack})`,
  reactionForced: (m) => `${m.term} forced: no stacks consumed, Status Level I`,
  consumed: (m) =>
    `consumed ${m.items.map((item) => (item.count != null ? `${item.count}× ${item.term}` : item.term)).join(', ')}`,
  deferred: (m) => `applies on the next Final Strike${m.window != null ? ` within ${m.window} s` : ''}`,
  delivers: (m, c) => `${c.name(m.operator)}'s ${m.skill} lands on this Final Strike`,
  landsLater: (m) => `its statuses land ${m.seconds.toFixed(2)} s after the cast, during the next steps`,
  landsHere: (m, c) => `${c.name(m.operator)}'s ${m.skill} (step ${m.step}) lands here`,
  waitsForHit: (m, c) => `waits ${m.seconds.toFixed(2)} s for ${c.name(m.operator)}'s battle skill to land`,
  waitsForStrike: (m, c) => `waits ${m.seconds.toFixed(2)} s for ${c.name(m.operator)}'s Final Strike to hit`,
  waitsForComboHit: (m, c) => `waits ${m.seconds.toFixed(2)} s for ${c.name(m.operator)}'s combo to hit`,
  applies: (m) => m.terms.join(', '),
  debuffActive: (m) => (m.until == null ? 'active' : `active until ${m.until.toFixed(1)} s`),
  spRecovered: (m) => `+${m.sp} SP recovered`,
  spRecoveredFor: (m, c) => `+${m.sp} SP recovered by ${c.name(m.operator)}'s ${m.skill}: its hit ate the stacks here`,
  spReturned: (m) => `+${m.sp} SP returned for consuming ${m.term}`,
  stagesAreHits: (m) => `one press: stage ${m.written} is a hit of the same cast, played as the whole skill`,
  movesByStacks: (m) =>
    `${m.moves} ${m.moves === 1 ? 'sequence' : 'sequences'} for ${m.stacks} consumed ${m.stacks === 1 ? 'stack' : 'stacks'}${m.enhanced ? ', the last one enhanced' : ''}`,
  linkSpent: (m) => `spends ${m.count} Link: DMG +${Math.round(m.bonus * 100)} %`,
  crystalsShattered: (m, c) =>
    m.owner === m.by ? 'shatters the Originium Crystals' : `shatters ${c.name(m.owner)}'s Originium Crystals`,
  perfectDodge: (m) => `perfect dodge: +${m.sp} SP, regen paused for ${m.pause} s`,
  skillWindow: (m) =>
    `the next action may start ${m.seconds.toFixed(2)} s in (client frames${m.measured ? ', checked on video' : ''})`,
  cutsceneRegen: (m) => `ultimate cutscene: SP regen stands still for ${m.seconds.toFixed(2)} s`,
  markStacks: (m) => `${m.mark}: ${m.stacks} on the target`,
  vulnerableAdded: (m) => `+${m.count} Vulnerable, ${m.stacks} on the target`,
  markDetonated: (m) => `${m.mark} detonated: ${m.stacks} stacks, the status ×${m.boost}`,
  pause: (m) => `pause, ${m.seconds} s`,

  rotUnparsed: (m) => `line ${m.line}: could not read «${m.token}»`,
  rotNoActor: (m) => `line ${m.line}: an action without an operator «${m.token}»`,
  rotNoAction: (m) => `line ${m.line}: no actions`,
  rotUnknownOperator: (m) => `step ${m.step}: unknown operator «${m.actor}»`,
  draftStepCount: (m) => `${m.before} steps before, ${m.after} after reading back`,
  draftStepChanged: (m) => `step ${m.step}: was «${m.was}», now «${m.now}»`,
  importUnknownOperator: (m) => `unknown operator «${m.actor}» in the team`,
  importEmpty: () => 'no team and no steps: nothing to import',
  importTeamSize: (m) => `${m.count} operators act, and a team holds four`,
  importBadLink: () => 'the link is damaged: the rotation in it does not decode',

  statsNoCurve: (m) => `the operator has no ${m.stat} curve`,
  statsNoWeaponAtk: (m) => `${m.weapon} has no ATK curve`,
  statsNoWeapon: () => 'no weapon set — only the operator’s ATK counts',
  statsGearStatUnparsed: (m) => `gear stat not read: «${m.stat}» (${m.piece})`,
  statsNoGear: () => 'no gear set — a bare operator',
  statsTooMuchGear: (m) => `there are four gear slots, ${m.count} given`,

  evAttack: () => 'assembled in stats.ts',
  evDmgBonus: () =>
    '"DMG Dealt" and "DMG Bonus" are one additive group — visible on the stat screen (measured 2026-09-06)',
  evStaggered: () => 'Stagger page: +30 % damage taken',
  evWeaken: () => 'the wiki itself says "said to stack non-linearly" — the product here is an assumption',
  evDmgTaken: () => 'Breach, Electrification and Realspace Stasis add together, then multiply against DMG Bonus',
  evProtect: () => 'only the strongest applies, not the sum',
  evDefense: () => 'every enemy in the game has DEF 100 at any level, so exactly ×0.5',
  evResistConfirmed: () => 'resist letters from the wiki match the numbers in the game client',
  evResistInferred: () => 'resists were reconstructed from the letters in the game UI, never checked against a number',
  evLevelPhysical: () => 'Physical Status: (391 + level)/392, shown nowhere in game',
  evLevel: () => '(195 + level)/196, shown nowhere in game',
  evArtsIntensity: () => 'three measured points 2026-09-04, AI from 0 to 71.8, worst error 4 damage out of 14 221',
  noteDotNoCrit: () => 'Damage over time cannot crit — the crit was dropped.',
  noteNoLevel: () => 'Operator level not given — the hidden level multiplier was skipped.',
  noteArtsIntensityIgnored: () =>
    'Arts Intensity was given, but it does not touch plain skill damage — verified on three numbers.',

  buffNoTrigger: (m) => `${m.effect}: stacks without a trigger — not tracked, use the build editor's assumption`,
  buffAssumed: (m) => `${m.effect}: "${m.condition}" assumed true — the dummy never hits back`,
  buffNoDuration: (m) => `${m.effect}: no duration in the text — treated as lasting to the end of the track`,
  buffCritUntracked: (m) => `${m.effect}: crit-triggered stacks are not tracked yet`,
  buffCritExpected: (m) =>
    `${m.effect}: crit-triggered stacks by expectation — each hit adds the crit rate, a stack per whole crit`,
  buffNeverOnDummy: (m) => `${m.effect}: "${m.trigger}" never fires on the dummy`,
  buffTriggerUntracked: (m) => `${m.effect}: trigger "${m.trigger}" is not tracked`,

  noLayout: (m, c) =>
    `talents and potentials (${m.talents} talents) — no effect layout written for ${c.name(m.operator)} yet`,
  unmodeled: (m) => `${m.where} — ${m.text}`,
  staleLayout: (m) => `${m.effect} — the wiki text changed since this was parsed, the layout may be stale`,
  weaponNoLayout: (m) => `${m.weapon} (${m.component}) — no effect layout written yet`,
  setNoLayout: (m) => `set bonus ${m.set} — no effect layout written yet`,
  trackCorrosion: () =>
    'Corrosion: shred steps up once a second from the moment it lands (client); a hit inside a step takes the value at the step start',
  trackLink: () =>
    'Link counts on every hit of the cast that spends it; not measured for hits the game files under another damage type',
  trackNextStep: () =>
    "a buff a cast switches on reaches the cast's later moves and the steps after it, not the move that switched it on — unless it fires on what that hit applies (measurements, #23, #61)",
  trackHitTimes: () =>
    'a hit that lands after a later press takes the buffs standing then (client hit times); a hit inside its own step takes what stood at its press',
  trackHitGuess: (m, c) => `${c.name(m.operator)}'s ${m.skill}: the wiki's rows and the client's hits differ in number — every row lands on the last hit`,
  trackStatusSnapshot: () =>
    "a status debuff keeps the applier's Arts Intensity from the step that applied it, track buffs included; whether the game reads it then or on every hit is open (measurements, #46)",
  trackStaggerAtStart: () =>
    'Staggered +30 % is checked per hit (measurements, #45), but which hit carries a cast\'s Stagger is known only for First Strike rows: otherwise the step that fills the meter goes without it and the next ones have it',
  trackGrantSnapshot: () =>
    "a skill's Susceptibility and Amp keep the value from the step that applied them — Will, Intellect and Vulnerable stacks as they stood then; Xaihi's crystal counts the striker at Max HP (measurements, #50)",
  trackGrantUncounted: (m, c) =>
    `applied, not counted: ${m.rows
      .map((row) => `${c.name(row.operator)} — ${row.term} (${row.reason === 'chance' ? 'left to chance' : 'one operator, on a condition'})`)
      .join('; ')}`,
  trackNoLayout: (m, c) => `${c.name(m.operator)}: no effect layout — talents give no buffs on the track`,
  trackConditional: (m, c) => `conditional rows: ${rowList(m.rows, c)}`,
  trackHitCount: (m, c) => `hit count unknown, counted once: ${rowList(m.rows, c)}`,
  trackBarrage: (m, c) =>
    `${c.name(m.operator)}'s ultimate: shots by the client's frames; a crit stack on every shot, not every sequence as the wiki says (measurements, #52)`,
  trackFuse: (m, c) =>
    `${c.name(m.operator)}: ${m.name} is counted at the battle skill step; it goes off ${m.fuse == null ? 'later' : `${m.fuse.toFixed(1)} s later`}, with its Nature Infliction (measurements, #53)`,
};

const ASIS: MessageContext = { name: (key) => key };

/** A message as text. Without a context, operators show by key. */
export function formatMessage(
  message: Message,
  context: MessageContext = ASIS,
  catalog: Catalog = EN_MESSAGES,
): string {
  const format = catalog[message.code] as (message: Message, context: MessageContext) => string;
  return format(message, context);
}

/**
 * A trigger verdict that names what opened the combo. A combo whose trigger
 * has no requirements gets an empty list, and there is nothing to show.
 */
export function openedBy(
  verdict: Message | undefined,
): Extract<Message, { code: 'triggerOpenedBy' }> | undefined {
  return verdict?.code === 'triggerOpenedBy' && verdict.by.length > 0 ? verdict : undefined;
}
