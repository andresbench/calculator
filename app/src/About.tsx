/**
 * What the site is, where its data comes from, and whose the game is.
 *
 * The attribution the wiki's CC BY-SA licence asks for lives here: source,
 * licence and the fact that the data was modified. So does the disclaimer
 * that the project is unofficial (see NOTICE), and the note that the
 * project is made with AI.
 */

import type { Bundle } from '@engine/index.js';

import { useLang, useT, type Lang } from './i18n/index.js';

const REPO = 'https://github.com/andresbench/calculator';
const MEASUREMENTS = `${REPO}/blob/main/docs/measurements.md`;
const ISSUES = `${REPO}/issues`;
/** The guide as plain pages on the site (seo.ts builds them from docs/). */
const GUIDE = { en: '/guide/', ru: '/ru/guide/' };
/** A plain link, not Ko-fi's overlay widget: no third-party script on the page. */
export const KOFI = 'https://ko-fi.com/andresbench';
const COMMIT = typeof __BUILD_COMMIT__ === 'string' ? __BUILD_COMMIT__ : '';

/** The about page: what the project is, how it was made, where its data comes from. */
export function About({ bundle }: { bundle: Bundle }): JSX.Element {
  const t = useT();
  const lang = useLang((state) => state.lang);
  return (
    <article className="about">
      <h2>{t.about.title}</h2>
      <p className="hint">{t.site.alphaTitle}</p>
      <p>{t.about.what}</p>
      <p>
        {t.about.guide}{' '}
        <a href={GUIDE[lang]}>
          {t.about.guideLink}
        </a>
      </p>
      <p>{t.about.honesty}</p>
      <p>
        {t.about.measured}{' '}
        <a href={MEASUREMENTS} target="_blank" rel="noreferrer">
          docs/measurements.md
        </a>
      </p>

      <h3>{t.about.madeTitle}</h3>
      <p>{t.about.made}</p>
      <p>
        {t.about.wrong}{' '}
        <a href={ISSUES} target="_blank" rel="noreferrer">
          {t.about.issues}
        </a>
      </p>

      <h3>{t.about.dataTitle}</h3>
      <p>
        {t.about.data('Endfield Talos Wiki', bundle.source.license)}{' '}
        <a href={bundle.source.wiki} target="_blank" rel="noreferrer">
          endfield.wiki.gg
        </a>{' '}
        ·{' '}
        <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer">
          CC BY-SA 4.0
        </a>
      </p>
      <p className="hint">{t.footer.snapshot(bundle.source.pages, bundle.source.maxRevid, bundle.generatedAt.slice(0, 10))}</p>
      <p>{t.about.datamine}</p>
      <p>
        {t.about.enka}{' '}
        <a href="https://enka.network/" target="_blank" rel="noreferrer">
          enka.network
        </a>
      </p>
      <p>{t.about.stats}</p>
      <p className="hint">
        {t.about.assets} {t.about.unofficial}
      </p>

      <h3>{t.about.codeTitle}</h3>
      <p>
        {t.about.code}{' '}
        <a href={REPO} target="_blank" rel="noreferrer">
          github.com/andresbench/calculator
        </a>
      </p>
      <p className="hint">{COMMIT ? t.about.build(COMMIT) : t.about.dev}</p>

      <h3>{t.about.supportTitle}</h3>
      <p>
        {t.about.support}{' '}
        <a href={KOFI} target="_blank" rel="noreferrer">
          ko-fi.com/andresbench
        </a>
      </p>
    </article>
  );
}

/** EN / RU, remembered per browser. */
export function LanguageSwitch(): JSX.Element {
  const t = useT();
  return (
    <span className="lang" role="group" aria-label={t.language.label}>
      <LangButton lang="en" label="EN" title={t.language.en} />
      <LangButton lang="ru" label="RU" title={t.language.ru} />
    </span>
  );
}


function LangButton({ lang, label, title }: { lang: Lang; label: string; title: string }): JSX.Element {
  const current = useLang((state) => state.lang);
  const setLang = useLang((state) => state.setLang);
  return (
    <button
      type="button"
      className={current === lang ? 'chip chip--on' : 'chip'}
      title={title}
      aria-pressed={current === lang}
      onClick={() => setLang(lang)}
    >
      {label}
    </button>
  );
}
