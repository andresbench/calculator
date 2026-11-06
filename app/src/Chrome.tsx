/**
 * The site's frame: the header with the logo and the sections, and the footer
 * with the attribution the wiki's licence asks for. The same on every screen.
 */

import type { Bundle } from '@engine/index.js';

import logo from '../assets/logo.svg?raw';
import { LanguageSwitch } from './About.js';
import { useT } from './i18n/index.js';

export type Screen = 'roster' | 'track' | 'about';

const SECTIONS: Screen[] = ['roster', 'track', 'about'];

/**
 * The logo, inline. Its own `<style>` would become a page-wide stylesheet
 * (`.line`, `.gold`) once inlined, so it is dropped; `styles.css` paints it.
 */
const LOGO = logo.replace(/<style>[\s\S]*?<\/style>/, '');

export function SiteHeader({ screen, onNavigate }: { screen: Screen; onNavigate: (screen: Screen) => void }): JSX.Element {
  const t = useT();
  return (
    <header className="site">
      <a
        className="site__brand"
        href="#"
        onClick={(event) => {
          event.preventDefault();
          onNavigate('roster');
        }}
      >
        {/* Inline, so the app's colours paint it whatever the system theme is. */}
        <span className="site__logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: LOGO }} />
        <span className="site__name">Andre&rsquo;s Bench</span>
        <span className="site__tag">{t.site.tag}</span>
      </a>
      <nav className="site__nav" aria-label={t.site.navLabel}>
        {SECTIONS.map((section) => (
          <button
            key={section}
            type="button"
            className={screen === section ? 'chip chip--on' : 'chip'}
            aria-current={screen === section ? 'page' : undefined}
            onClick={() => onNavigate(section)}
          >
            {t.site.nav[section]}
          </button>
        ))}
        <LanguageSwitch />
      </nav>
    </header>
  );
}

export function SiteFooter({ bundle, onAbout }: { bundle: Bundle; onAbout: () => void }): JSX.Element {
  const t = useT();
  return (
    <footer className="foot">
      <div className="foot__src">
        {t.footer.snapshot(bundle.source.pages, bundle.source.maxRevid, bundle.generatedAt.slice(0, 10))}
      </div>
      <div className="foot__src foot__links">
        <span>
          {t.about.data('Endfield Talos Wiki', bundle.source.license)} {t.about.unofficial}
        </span>
        <button type="button" className="linkish" onClick={onAbout}>
          {t.footer.about}
        </button>
      </div>
    </footer>
  );
}
