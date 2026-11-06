/**
 * Tooltip content, built from the bundle.
 *
 * Every explanation here quotes the data rather than paraphrasing it: the
 * glossary line as the wiki wrote it, the skill description as it appears in
 * game, the numbers at the level the build actually has. A tooltip that
 * restates a mechanic in my own words would be one more place for the
 * project's own understanding to drift from the source.
 */

import type { Bundle, Effect, EffectApply, Frame, Operator, Skill } from '@engine/index.js';
import { classify, openedBy } from '@engine/index.js';

import { currentT } from './i18n/index.js';
import { currentNames, opName } from './i18n/names.js';
import { say } from './messages.js';

import { InfoBody } from './Info.js';

/**
 * What a term means, who applies it, and how it behaves on the target.
 *
 * `as` overrides the classification label. The counter row for Vulnerable
 * needs it: the bare term classifies as an umbrella (a trigger asking for
 * "Vulnerable" is closed by Lift, Crush and the rest), but on that row it is
 * the stack itself, and calling it a category there would be confusing.
 */
export function explainTerm(bundle: Bundle, term: string, as?: string): JSX.Element {
  const entry = bundle.glossary[term];
  const mechanic = bundle.mechanics[term];
  const kind = classify(term).kind;
  const t = currentT();
  const n = currentNames();

  const appliedBy = Object.entries(bundle.synergy?.applies ?? {})
    .filter(([, terms]) => term in terms)
    .map(([operatorKey]) => opName(bundle, operatorKey));

  return (
    <InfoBody
      title={n.term(term)}
      kind={as ?? t.explain.behaviour[kind]}
      source={mechanic?.revid ? t.explain.revid(mechanic.revid) : 'Module:Glossary/misc'}
    >
      {entry?.description && <p className="infocard__text">{entry.description}</p>}
      {appliedBy.length > 0 && (
        <p className="infocard__meta">
          {t.explain.appliedBy} {appliedBy.slice(0, 6).join(', ')}
          {appliedBy.length > 6 ? t.common.andMore(appliedBy.length - 6) : ''}
        </p>
      )}
    </InfoBody>
  );
}

/** One `apply` line as a readable phrase: stat, number and condition. */
export function describeApply(apply: EffectApply): string {
  const t = currentT().explain;
  const sign = apply.rawValue > 0 ? '+' : '';
  const amount =
    apply.unit === 'frac'
      ? `${sign}${apply.rawValue} %`
      : apply.unit === 'mult'
        ? `×${apply.value}`
        : `${sign}${apply.rawValue}`;
  const where = [
    apply.attribute,
    apply.element,
    apply.skill,
    apply.skillType,
    apply.staggered ? t.apply.vsStaggered : null,
  ]
    .filter(Boolean)
    .join(' ');
  const per = apply.perAttribute ? t.apply.perPoint(apply.perAttribute.join(' + ')) : '';
  const stacks = apply.stacks ? t.apply.upTo(apply.stacks.max) : '';
  const duration = apply.duration != null ? t.apply.for(apply.duration) : '';
  const needs = apply.targetHas ? t.apply.needs(apply.targetHas.join(t.apply.or)) : '';
  return `${amount}${per} ${t.stat[apply.stat] ?? apply.stat}${where ? ` (${where})` : ''}${stacks}${duration}${needs}`;
}

/**
 * A parsed effect: the wiki text as it stands, then where each number lands.
 *
 * The text is quoted, never paraphrased — it is the thing the layout claims
 * to interpret, and the reader has to be able to check the claim. `stale`
 * means the wiki has since changed that text, so the layout below it may
 * describe a previous patch.
 */
export function explainEffect(effect: Effect): JSX.Element {
  const t = currentT().explain;
  return (
    <InfoBody
      title={effect.source.name}
      kind={`${effect.source.kind}${effect.source.condition ? ` · ${effect.source.condition}` : ''}`}
      source={effect.revid ? t.revid(effect.revid) : undefined}
    >
      {effect.text && <p className="infocard__text">{effect.text}</p>}
      {effect.apply.length > 0 && (
        <ul className="infocard__list">
          {effect.apply.map((apply, index) => (
            <li key={`${apply.stat}:${index}`}>{describeApply(apply)}</li>
          ))}
        </ul>
      )}
      {effect.unmodeled && (
        <p className="infocard__meta">{t.notModelled(effect.unmodeled)}</p>
      )}
      {effect.stale && (
        <p className="infocard__meta">{t.stale}</p>
      )}
      <p className="infocard__meta">{t.confidence(effect.confidence, effect.evidence ?? null)}</p>
      {effect.note && <p className="infocard__meta">{effect.note}</p>}
    </InfoBody>
  );
}

const STAT_ORDER = ['sp', 'energy', 'sec', 'stagger', 'frac', 'flat'];

/** A skill at the level this build has it, with its costs and numbers. */
export function explainSkill(
  operator: Operator,
  skill: Skill,
  level: number,
  extra?: {
    openedBy?: string;
    applies?: string;
    /** Team-slot effects of this step: cooldown cuts, the Heat/Cryo choice, combo order. */
    slot?: string[];
    problems?: string[];
    at?: number;
  },
): JSX.Element {
  const t = currentT().explain;
  const n = currentNames();
  const index = Math.min(Math.max(level, 1), 12) - 1;
  const rows = [...skill.stats].sort(
    (a, b) => STAT_ORDER.indexOf(a.unit) - STAT_ORDER.indexOf(b.unit),
  );

  return (
    <InfoBody
      title={n.skill(skill.name)}
      kind={t.skillKind(n.term(skill.type), level)}
      source={`${n.operator(operator.key, operator.name)}${operator.revid ? ` · ${t.revid(operator.revid)}` : ''}`}
    >
      {extra?.at != null && <p className="infocard__meta">{t.at(extra.at)}</p>}
      {skill.text && <p className="infocard__text">{skill.text}</p>}

      {rows.length > 0 && (
        <table className="infocard__stats">
          <tbody>
            {rows.slice(0, 10).map((stat) => {
              const value = stat.values[index];
              if (value == null) return null;
              const shown =
                stat.unit === 'frac'
                  ? `${(value * 100).toFixed(0)} %`
                  : stat.unit === 'sec'
                    ? `${value} s`
                    : String(value);
              return (
                <tr key={stat.label}>
                  <td>{stat.label}</td>
                  <td>{shown}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {extra?.openedBy && <p className="infocard__good">{t.openedBy(extra.openedBy)}</p>}
      {extra?.applies && <p className="infocard__meta">{t.applies(extra.applies)}</p>}
      {extra?.slot?.map((line) => (
        <p className="infocard__meta" key={line}>
          {line}
        </p>
      ))}
      {extra?.problems?.map((problem) => (
        <p className="infocard__bad" key={problem}>
          {problem}
        </p>
      ))}
    </InfoBody>
  );
}

/** The whole state of the fight at one step, for the lane blocks. */
/** Verdicts that say what the step did with resources and statuses: shown as lines. */
const STEP_NOTES = new Set([
  'stagesAreHits',
  'movesByStacks',
  'linkSpent',
  'crystalsShattered',
  'spRecovered',
  'spReturned',
]);

export function explainFrame(bundle: Bundle, frame: Frame): JSX.Element | null {
  const operator = frame.step.actor ? bundle.operators[frame.step.actor] : null;
  if (!operator) return null;

  if (frame.step.kind === 'DODGE' || frame.step.kind === 'WAIT') {
    const track = currentT().track;
    const said = [...frame.verdicts.values()].map((value) => say(bundle, value));
    return (
      <InfoBody title={frame.step.kind === 'DODGE' ? track.dodge : track.pause} kind={opName(bundle, operator.key)}>
        <p className="infocard__text">{frame.step.kind === 'DODGE' ? track.dodgeTitle : track.pauseTitle}</p>
        {said.map((line) => (
          <p key={line} className="infocard__meta">
            {line}
          </p>
        ))}
      </InfoBody>
    );
  }

  const type =
    frame.step.kind === 'BS'
      ? 'Battle Skill'
      : frame.step.kind === 'CS'
        ? 'Combo Skill'
        : frame.step.kind === 'ULT'
          ? 'Ultimate'
          : 'Basic Attack';
  const skill = operator.skills.find((item) => item.type === type);
  if (!skill) return null;

  const entry = bundle.roster?.operators?.[operator.key];
  const level =
    type === 'Battle Skill'
      ? (entry?.skills?.battle ?? 1)
      : type === 'Combo Skill'
        ? (entry?.skills?.combo ?? 1)
        : type === 'Ultimate'
          ? (entry?.skills?.ultimate ?? 1)
          : (entry?.skills?.basic ?? 1);

  const t = currentT().explain;
  const opened = frame.verdicts.get(`${frame.step.index}:trigger`);
  const applies = frame.verdicts.get(`${frame.step.index}:applies`);
  const prefix = `${frame.step.index}:`;
  const slot: string[] = [];
  for (const [key, value] of frame.verdicts) {
    if (!key.startsWith(prefix)) continue;
    const what = key.slice(prefix.length);
    if (what === 'cooldownCut') slot.push(t.cooldownCut(say(bundle, value)));
    else if (what.startsWith('slot:')) slot.push(t.teamSlot(say(bundle, value)));
    else if (what === 'priority' && value.code !== 'priorityOutOfOrder') slot.push(t.priority(say(bundle, value)));
    else if (STEP_NOTES.has(value.code)) slot.push(say(bundle, value));
  }

  return explainSkill(operator, skill, level, {
    ...(openedBy(opened) ? { openedBy: say(bundle, opened!) } : {}),
    ...(applies ? { applies: say(bundle, applies) } : {}),
    ...(slot.length > 0 ? { slot } : {}),
    ...(frame.problems.length > 0 ? { problems: frame.problems.map((problem) => say(bundle, problem)) } : {}),
    at: frame.world,
  });
}

/** Why the SP bar is where it is. */
export function explainSp(sp: number): JSX.Element {
  const t = currentT().explain;
  return (
    <InfoBody title={`${sp.toFixed(0)} SP`} kind={t.spBars(sp / 100)}>
      <p className="infocard__text">{t.sp}</p>
      <p className="infocard__meta">{t.spRegen}</p>
    </InfoBody>
  );
}
