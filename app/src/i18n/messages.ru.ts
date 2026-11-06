/**
 * Сообщения движка по-русски. Тип — `Catalog` из движка: без строки для
 * какого-нибудь кода приложение не соберётся.
 *
 * Термины в параметрах («Cryo Infliction», имя навыка) приходят из данных
 * и остаются как в вики.
 */

import { rowList, type Catalog, type SkillType } from '@engine/index.js';

import { plural } from './ru.js';

/** Skill types as the client's Russian names them. */
const SKILL_RU: Record<SkillType, string> = {
  'Basic Attack': 'обычная атака',
  'Battle Skill': 'боевой навык',
  'Combo Skill': 'комбонавык',
  Ultimate: 'супернавык',
};

const slot = (n: number): string => `слот ${String(n).padStart(2, '0')}`;

export const RU_MESSAGES: Catalog = {
  notInTeam: (m) => `нет в отряде: ${m.actor}`,
  noSkill: (m, c) => `у ${c.name(m.operator)} нет навыка ${m.skill}`,
  deferredExpired: (m, c) =>
    `${m.skill} (${c.name(m.operator)}, шаг ${m.step}) пропал: за время действия не было последнего удара`,
  ultimateNotCharged: (m) => `супернавык не заряжен: нужно ${m.needs}, есть ${m.has.toFixed(1)}`,
  triggerMissing: (m) =>
    `триггеру нужно ${m.terms.map((item) => `«${item.term}»${item.min ? ` ×${item.min}` : ''}`).join(' или ')}` +
    `${m.consumed ? ' (поглощение)' : ''}, а на цели в этот момент этого нет`,
  triggerBlocked: (m) =>
    `триггеру нужна цель без ${m.terms.map((term) => `«${term}»`).join(' и ')}, а на цели это сейчас есть`,
  triggerOutOfStance: (m, c) => `триггер работает только в ${m.stance}, а ${c.name(m.operator)} сейчас не в ней`,
  comboOutOfOrder: (m, c) =>
    `сработал одновременно с комбонавыком ${c.name(m.other)} (шаг ${m.otherStep}), но у ${c.name(m.operator)} ` +
    'приоритет выше, и игра нажмёт его первым — поменяйте шаги местами или приоритет',
  finisherNoMeter: () => 'добиванию нужна ошеломлённая цель, а шкала ошеломления не задана — выберите врага',
  finisherNotStaggered: (m) => `добиванию нужна ошеломлённая цель: ${m.stagger.toFixed(0)} из ${m.meter}`,

  secondPhase: (m) => `${m.to}: вторая фаза, энергия не тратится`,
  inflictionExpired: (m) => `${m.element} Infliction истёк`,
  spEnough: () => 'хватает',
  spWaiting: () => 'ожидание',
  energyCharged: () => 'заряжен',
  energyNotCharged: () => 'не заряжен',
  cooldownCutEmptySlot: (m) => `${slot(m.slot)} пуст`,
  cooldownCut: (m, c) =>
    `${c.name(m.operator)} (${slot(m.slot)}): кулдаун комбонавыка −${m.seconds} с, готов ${m.was.toFixed(1)} → ${m.now.toFixed(1)} с`,
  cooldownCutWasted: (m, c) =>
    `${c.name(m.operator)} (${slot(m.slot)}): комбонавык не был на кулдауне — −${m.seconds} с впустую`,
  cooldownReady: () => 'готов',
  cooldownWaiting: () => 'ожидание',
  triggerNotOpen: () => 'не открыт',
  triggerUnread: (m) =>
    m.own ? `триггер не проверяется: движок не считает ${m.own}` : 'триггер не проверяется: трек не видит этого события',
  triggerOpenedBy: (m) => m.by.map((hit) => `${hit.term} (шаг ${hit.step})`).join(', '),
  priorityOutOfOrder: () => 'не по порядку',
  priorityInOrder: (m) => `по порядку после шага ${m.after}`,
  finalStrikeSp: (m) => `+${m.sp} SP`,
  finisherReady: () => 'цель ошеломлена',
  finisherNotReady: () => 'цель НЕ ошеломлена',
  targetStaggered: () => 'цель ошеломлена',
  stanceEntered: (m) => `${m.stance} до ${m.until.toFixed(1)} с`,
  grantArmed: (m) =>
    `${m.term} — на ${m.times} следующих Final Strike управляемого${m.until == null ? '' : ` до ${m.until.toFixed(1)} с`}`,
  grantOnStrike: (m, c) => `${m.term} от ${c.name(m.operator)} на этом Final Strike: осталось ${m.left}`,
  grantWithheld: (m) =>
    m.has != null ? `${m.term} не наложена: на цели нет ${m.has}` : `${m.term} не наложена: на цели есть ${m.lacks ?? ''}`,
  stockGained: (m) => `${m.term}: на поле ${m.count}`,
  stockSpent: (m) =>
    `забирает ${m.term}: ${m.spent}, создаёт ${m.makes}: ${m.made}${m.sp > 0 ? `, возврат +${m.sp} SP` : ''}`,
  transformGained: (m) => `боевой навык становится ${m.move}${m.until == null ? '' : ` до ${m.until.toFixed(1)} с`}`,
  goneBeforeStrike: (m) => `${m.term} кончается на ${m.until.toFixed(1)} с, раньше завершающего удара: не поглощён`,
  strikeAfter: (m) => `${m.talent}: эта базовая атака — Final Strike, один удар`,
  echoed: (m) =>
    m.elements.length > 0
      ? `повторяет ${m.elements.map((element) => `${element} Infliction`).join(', ')}: уже на цели`
      : `ничего не повторяет: на цели нет ${m.min > 1 ? `${m.min}+ стаков ` : ''}нужных элементов`,
  detonated: (m) => `подрывает ${m.name} с шага ${m.step}: взрыв засчитан здесь, усиленный`,
  barrage: (m) => `всё окно: ${m.shots} выстрелов и завершающий удар — ${m.seconds.toFixed(1)} с`,
  transformedCast: (m) => `${m.move}: считается как ${SKILL_RU[m.as]}`,
  enhancedBasicGained: (m) => `базовая атака — ${m.move} до ${m.until.toFixed(1)} с`,
  enhancedBasicPaused: (m) => `окно ${m.move} стоит на паузе, пока идёт каст: теперь до ${m.until.toFixed(1)} с`,
  enhancedBasicCast: (m) => `${m.move}: цепочка ульты, урон базовой атаки`,
  duringUltimateCast: (m) => `боевой внутри ${m.ultimate}: удары «During Ultimate»`,
  ownStacksShort: (m) => `${m.term}: ${m.have} из ${m.need} — доп. удара нет`,
  ownStacksSpent: (m) => `тратит ${m.term} (${m.spent}): доп. удар${m.energy > 0 ? `, +${m.energy} энергии ульты` : ''}`,
  ownStacksGained: (m, ctx) => `${ctx.name(m.operator)}: ${m.term} ${m.count}`,
  ownStacksAbsorbed: (m, ctx) => `${ctx.name(m.operator)} поглощает ${m.term} (${m.absorbed}) — ${m.talent}`,
  chargesGained: (m) => `${m.term}: ${m.points}${m.until == null ? '' : ` до ${m.until.toFixed(1)} с`}`,
  chargeSpent: (m, c) =>
    `${c.name(m.operator)} тратит 1 ${m.term}: осталось ${m.left}${m.sp > 0 ? `, +${m.sp} SP` : ''}`,
  staggerNode: (m) => `узел ошеломления на ${Math.round(m.share * 100)} % шкалы`,
  slotSwap: (m, c) => `${m.alt} вместо ${m.term}: в ${slot(m.slot)} ${c.name(m.operator)} (${m.element})`,
  slotKeep: (m) => `${m.term}: в ${slot(m.slot)} не ${m.element}`,
  shatter: () => 'Solidification поглощён → Shatter',
  statusLevel: (m) => String(m.level),
  reaction: (m) => `${m.element} на ${m.consumed}× ${m.standing} → ${m.reaction}, Status Level ${m.consumed}`,
  burst: (m) => `${m.element} Burst (стак ${m.stack})`,
  reactionForced: (m) => `${m.term} принудительно: стаки не поглощены, Status Level I`,
  consumed: (m) =>
    `поглощено: ${m.items.map((item) => (item.count != null ? `${item.count}× ${item.term}` : item.term)).join(', ')}`,
  deferred: (m) => `ляжет на следующий последний удар${m.window != null ? ` в пределах ${m.window} с` : ''}`,
  delivers: (m, c) => `${m.skill} (${c.name(m.operator)}) ложится на этот последний удар`,
  applies: (m) => m.terms.join(', '),
  debuffActive: (m) => (m.until == null ? 'действует' : `действует до ${m.until.toFixed(1)} с`),
  spRecovered: (m) => `+${m.sp} SP восстановлено`,
  spReturned: (m) => `+${m.sp} SP возвращено за поглощение: ${m.term}`,
  stagesAreHits: (m) => `одно нажатие: стадия ${m.written} — удар того же каста, сыграна как весь навык`,
  movesByStacks: (m) =>
    `${m.moves} ${plural(m.moves, 'взмах', 'взмаха', 'взмахов')} за ${m.stacks} ${plural(m.stacks, 'поглощённый стак', 'поглощённых стака', 'поглощённых стаков')}${m.enhanced ? ', последний усиленный' : ''}`,
  linkSpent: (m) => `тратит Link ×${m.count}: урон +${Math.round(m.bonus * 100)} %`,
  crystalsShattered: (m, c) =>
    m.owner === m.by ? 'разбивает Originium Crystals' : `разбивает Originium Crystals: ${c.name(m.owner)}`,
  perfectDodge: (m) => `идеальный уворот: +${m.sp} SP, реген стоит ${m.pause} с`,
  skillWindow: (m) =>
    `следующее действие — через ${m.seconds.toFixed(2)} с (кадры клиента${m.measured ? ', проверено на видео' : ''})`,
  cutsceneRegen: (m) => `катсцена ульты: реген SP стоит ${m.seconds.toFixed(2)} с`,
  markStacks: (m) => `${m.mark}: ${m.stacks} на цели`,
  vulnerableAdded: (m) => `+${m.count} Vulnerable, на цели ${m.stacks}`,
  markDetonated: (m) => `${m.mark} взорван: ${m.stacks} стаков, статус ×${m.boost}`,
  pause: (m) => `пауза, ${m.seconds} с`,

  rotUnparsed: (m) => `строка ${m.line}: не разобрано «${m.token}»`,
  rotNoActor: (m) => `строка ${m.line}: действие без оперативника «${m.token}»`,
  rotNoAction: (m) => `строка ${m.line}: ни одного действия`,
  rotUnknownOperator: (m) => `шаг ${m.step}: неизвестный оперативник «${m.actor}»`,
  draftStepCount: (m) => `шагов было ${m.before}, после обратного разбора ${m.after}`,
  draftStepChanged: (m) => `шаг ${m.step}: было «${m.was}», стало «${m.now}»`,
  importUnknownOperator: (m) => `в отряде неизвестный оперативник «${m.actor}»`,
  importEmpty: () => 'ни отряда, ни шагов: импортировать нечего',
  importTeamSize: (m) => `действуют ${m.count} оперативников, а в отряде четыре места`,
  importBadLink: () => 'ссылка повреждена: ротация в ней не читается',

  statsNoCurve: (m) => `у оперативника нет кривой ${m.stat}`,
  statsNoWeaponAtk: (m) => `у ${m.weapon} нет кривой ATK`,
  statsNoWeapon: () => 'оружие не задано — считается только ATK оперативника',
  statsGearStatUnparsed: (m) => `стат снаряжения не разобран: «${m.stat}» (${m.piece})`,
  statsNoGear: () => 'снаряжение не задано — голый оперативник',
  statsTooMuchGear: (m) => `слотов снаряжения четыре, задано ${m.count}`,

  evAttack: () => 'собрана в stats.ts',
  evDmgBonus: () =>
    '«DMG Dealt» и «DMG Bonus» — одна аддитивная группа, видно на экране статов (замер 2026-09-06)',
  evStaggered: () => 'страница Stagger: +30 % получаемого урона',
  evWeaken: () => 'вики сама пишет «said to stack non-linearly» — произведение здесь допущение',
  evDmgTaken: () => 'Breach, Electrification и Realspace Stasis складываются, потом умножаются на DMG Bonus',
  evProtect: () => 'действует только сильнейшая, а не сумма',
  evDefense: () => 'у всех врагов в игре DEF 100 на любом уровне, поэтому ровно ×0,5',
  evResistConfirmed: () => 'буквы сопротивлений с вики совпадают с числами в клиенте игры',
  evResistInferred: () => 'сопротивления восстановлены по буквам из интерфейса игры и числом не проверены',
  evLevelPhysical: () => 'физический статус: (391 + уровень)/392, в игре нигде не показан',
  evLevel: () => '(195 + уровень)/196, в игре нигде не показан',
  evArtsIntensity: () => 'три замера 2026-09-04, сила искусств от 0 до 71,8, худшая ошибка — 4 урона из 14 221',
  noteDotNoCrit: () => 'Урон по времени не критует — крит отброшен.',
  noteNoLevel: () => 'Уровень оперативника не задан — скрытый множитель уровня пропущен.',
  noteArtsIntensityIgnored: () =>
    'Сила искусств задана, но на обычный урон навыка не влияет — проверено на трёх числах.',

  buffNoTrigger: (m) => `${m.effect}: стаки без триггера — на треке не ведутся, используйте допущение в редакторе билда`,
  buffAssumed: (m) => `${m.effect}: «${m.condition}» считается выполненным — манекен не бьёт в ответ`,
  buffNoDuration: (m) => `${m.effect}: в тексте нет длительности — считается до конца трека`,
  buffCritUntracked: (m) => `${m.effect}: стаки от крита пока не ведутся`,
  buffCritExpected: (m) =>
    `${m.effect}: стаки за крит — по ожиданию: каждый удар добавляет шанс крита, стак за каждый целый крит`,
  buffNeverOnDummy: (m) => `${m.effect}: «${m.trigger}» на манекене не срабатывает`,
  buffTriggerUntracked: (m) => `${m.effect}: триггер «${m.trigger}» не ведётся`,

  noLayout: (m, c) =>
    `таланты и потенциалы (талантов: ${m.talents}) — разметки эффектов для ${c.name(m.operator)} ещё нет`,
  unmodeled: (m) => `${m.where} — ${m.text}`,
  staleLayout: (m) => `${m.effect} — текст вики изменился после разбора, разметка может быть устаревшей`,
  weaponNoLayout: (m) => `${m.weapon} (${m.component}) — разметки эффекта ещё нет`,
  setNoLayout: (m) => `бонус сета ${m.set} — разметки эффекта ещё нет`,
  trackCorrosion: () =>
    'Corrosion: срез растёт раз в секунду с момента наложения (клиент); удар внутри шага берёт значение на начало шага',
  trackLink: () =>
    'Link считается на всех ударах каста, который его тратит; берут ли его удары, идущие как Crush (World Splitter), — открыто (замеры, п. 15)',
  trackNextStep: () => 'бафф, сработавший на шаге, считается со следующего шага; внутри одного каста — см. подсказку шага',
  trackStatusSnapshot: () =>
    'дебафф статуса держит силу искусств наложившего на шаге наложения, с баффами трека; берёт ли её игра в этот момент или на каждом ударе — открыто (замеры, п. 46)',
  trackStaggerAtStart: () =>
    'Ошеломление +30 % считается со шага после того, что заполнил шкалу: какие удары этого шага идут уже после пробития — открыто (замеры, п. 45)',
  trackGrantSnapshot: () =>
    'Susceptibility и Amp из скилла держат значение с шага наложения — Will, Intellect и стаки Vulnerable какими были тогда; кристалл Сяохи считает, что ударивший при полном HP (замеры, п. 50)',
  trackGrantUncounted: (m, c) =>
    `наложено, но не посчитано: ${m.rows
      .map((row) => `${c.name(row.operator)} — ${row.term} (${row.reason === 'chance' ? 'выпадает случайно' : 'одному оператору, по условию'})`)
      .join('; ')}`,
  trackNoLayout: (m, c) => `${c.name(m.operator)}: нет разметки эффектов — таланты не дают баффов на треке`,
  trackConditional: (m, c) => `условные строки: ${rowList(m.rows, c)}`,
  trackHitCount: (m, c) => `число ударов неизвестно, посчитано один раз: ${rowList(m.rows, c)}`,
  trackBarrage: (m, c) =>
    `${c.name(m.operator)}, ульта: выстрелы — по кадрам клиента; стак крита — на каждом выстреле, а не на серии, как пишет вики (замеры, п. 52)`,
  trackFuse: (m, c) =>
    `${c.name(m.operator)}, ${m.name}: взрыв засчитан на шаге боевого навыка, а случается ${m.fuse == null ? 'позже' : `через ${m.fuse.toFixed(1)} с`} — вместе с Nature Infliction (замеры, п. 53)`,
};
