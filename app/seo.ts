/**
 * Pages a search engine or an AI crawler can read without running the app.
 *
 * The app is one script: its HTML is an empty `#root`, and crawlers that do
 * not run JavaScript (most AI ones) see nothing. So the build also writes:
 *
 * * `/guide/` and `/ru/guide/` — the user guide (`docs/guide*.md`) as plain
 *   HTML, with its screenshots;
 * * `/guide/index.md`, `/ru/guide/index.md` — the same text as Markdown,
 *   which `llms.txt` points to;
 * * `/sitemap.xml`.
 *
 * The guide stays written once, in `docs/`; GitHub shows the same files.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { Marked, type Tokens } from 'marked';
import type { Plugin } from 'vite';

const SITE = 'https://andresbench.moe';
const REPO = 'https://github.com/andresbench/calculator';
const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));

interface Guide {
  lang: 'en' | 'ru';
  source: string;
  path: string;
  title: string;
  description: string;
  open: string;
  other: string;
}

const GUIDES: Guide[] = [
  {
    lang: 'en',
    source: 'guide.md',
    path: '/guide/',
    title: 'How to use Andre’s Bench — Arknights: Endfield damage calculator',
    description:
      'Guide to Andre’s Bench, a free damage calculator and rotation track for Arknights: Endfield: builds, Enka import, the rotation track, the .rot notation and what the numbers account for.',
    open: 'Open the calculator',
    other: 'Русская версия',
  },
  {
    lang: 'ru',
    source: 'guide.ru.md',
    path: '/ru/guide/',
    title: 'Как пользоваться Andre’s Bench — калькулятор урона Arknights: Endfield',
    description:
      'Руководство по Andre’s Bench — бесплатному калькулятору урона и треку ротаций для Arknights: Endfield: билды, импорт из Enka, трек ротаций, нотация .rot и что учитывают числа.',
    open: 'Открыть калькулятор',
    other: 'English version',
  },
];

/** A link in the guide, as it should read on the site. */
function rewrite(href: string): string {
  if (/^([a-z]+:|#)/i.test(href)) return href;
  if (href.startsWith('img/')) return `/guide/${href}`;
  const own = GUIDES.find((guide) => guide.source === href);
  if (own) return own.path;
  // Anything else in docs/ lives on GitHub.
  return new URL(href, `${REPO}/blob/main/docs/`).href;
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function render(markdown: string): string {
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === 'link' || token.type === 'image') {
        const link = token as Tokens.Link | Tokens.Image;
        link.href = rewrite(link.href);
      }
    },
    renderer: {
      heading({ tokens, depth, text }) {
        const inner = this.parser.parseInline(tokens);
        return `<h${depth} id="${slug(text)}">${inner}</h${depth}>\n`;
      },
      image({ href, title, text }) {
        const caption = title ? ` title="${escape(title)}"` : '';
        return `<img src="${href}" alt="${escape(text)}"${caption} loading="lazy">`;
      },
    },
  });
  return marked.parse(markdown, { async: false });
}

/** The Markdown copy, with links that work from anywhere: it is read on its own. */
function absolute(markdown: string): string {
  return markdown.replace(/\]\(([^)\s]+)\)/g, (_, href: string) => {
    const link = rewrite(href);
    return `](${link.startsWith('/') ? SITE + link : link})`;
  });
}

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page(guide: Guide, body: string): string {
  const other = GUIDES.find((item) => item !== guide)!;
  const alternates = GUIDES.map((item) => `<link rel="alternate" hreflang="${item.lang}" href="${SITE}${item.path}">`).join('\n    ');
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: guide.title,
    description: guide.description,
    inLanguage: guide.lang,
    url: `${SITE}${guide.path}`,
    isPartOf: { '@type': 'WebSite', name: 'Andre’s Bench', url: `${SITE}/` },
    about: { '@type': 'VideoGame', name: 'Arknights: Endfield' },
  };
  return `<!doctype html>
<html lang="${guide.lang}">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escape(guide.title)}</title>
    <meta name="description" content="${escape(guide.description)}">
    <link rel="canonical" href="${SITE}${guide.path}">
    ${alternates}
    <link rel="alternate" hreflang="x-default" href="${SITE}/guide/">
    <link rel="alternate" type="text/markdown" href="${SITE}${guide.path}index.md">
    <link rel="icon" type="image/svg+xml" href="/favicon.svg">
    <meta name="theme-color" content="#14161a">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Andre’s Bench">
    <meta property="og:title" content="${escape(guide.title)}">
    <meta property="og:description" content="${escape(guide.description)}">
    <meta property="og:url" content="${SITE}${guide.path}">
    <meta property="og:image" content="${SITE}/og.png">
    <meta property="og:locale" content="${guide.lang === 'ru' ? 'ru_RU' : 'en_US'}">
    <meta name="twitter:card" content="summary_large_image">
    <script type="application/ld+json">${JSON.stringify(ld)}</script>
    <style>${STYLE}</style>
  </head>
  <body>
    <header class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" width="32" height="32"> Andre’s Bench</a>
      <nav>
        <a href="${other.path}" hreflang="${other.lang}" lang="${other.lang}">${guide.other}</a>
        <a class="cta" href="/">${guide.open}</a>
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer>
      <a href="/">andresbench.moe</a> · <a href="${REPO}">GitHub</a> · <a href="https://ko-fi.com/andresbench">Ko-fi</a>
    </footer>
  </body>
</html>
`;
}

/** The app's palette (styles.css): the site is always dark. */
const STYLE = `
:root { --bg: #14161a; --panel: #1c1f26; --line: #2a2f39; --text: #e6e6e6; --dim: #9099a8; --accent: #7aa2f7; --gold: #e0b75a; color-scheme: dark; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
.top, main, footer { max-width: 820px; margin: 0 auto; padding: 0 16px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding-top: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; color: var(--text); text-decoration: none; font-weight: 650; font-size: 20px; }
nav { display: flex; gap: 14px; align-items: center; flex-wrap: wrap; }
a { color: var(--accent); }
.cta { color: var(--bg); background: var(--gold); padding: 6px 14px; border-radius: 999px; text-decoration: none; font-weight: 600; }
main { padding-top: 8px; padding-bottom: 32px; }
h1 { font-size: 30px; line-height: 1.25; margin: 24px 0 12px; }
h2 { font-size: 22px; margin: 36px 0 10px; padding-top: 8px; border-top: 1px solid var(--line); }
h3 { font-size: 18px; margin: 26px 0 8px; }
img { display: block; max-width: 100%; height: auto; margin: 16px 0; border: 1px solid var(--line); border-radius: 8px; }
code { font: 0.9em ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--panel); padding: 1px 5px; border-radius: 4px; }
pre { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
pre code { padding: 0; background: none; }
blockquote { margin: 16px 0; padding: 8px 16px; border-left: 3px solid var(--gold); background: var(--panel); border-radius: 0 8px 8px 0; }
table { border-collapse: collapse; display: block; overflow-x: auto; margin: 16px 0; }
th, td { border: 1px solid var(--line); padding: 6px 10px; text-align: left; vertical-align: top; }
footer { padding-top: 16px; padding-bottom: 32px; border-top: 1px solid var(--line); color: var(--dim); font-size: 14px; }
`;

function sitemap(): string {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${SITE}/`, priority: '1.0' },
    ...GUIDES.map((guide) => ({ loc: `${SITE}${guide.path}`, priority: '0.8' })),
  ];
  const alternates = GUIDES.map((guide) => `    <xhtml:link rel="alternate" hreflang="${guide.lang}" href="${SITE}${guide.path}"/>`).join('\n');
  const entries = urls.map(({ loc, priority }) => {
    const extra = loc.endsWith('/guide/') ? `\n${alternates}` : '';
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${today}</lastmod>\n    <priority>${priority}</priority>${extra}\n  </url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join('\n')}
</urlset>
`;
}

/** Writes the guide pages, their Markdown and the sitemap into the build. */
export function staticPages(): Plugin {
  return {
    name: 'andresbench-static-pages',
    apply: 'build',
    generateBundle() {
      for (const guide of GUIDES) {
        const markdown = readFileSync(`${DOCS}${guide.source}`, 'utf8');
        const dir = guide.path.slice(1);
        this.emitFile({ type: 'asset', fileName: `${dir}index.html`, source: page(guide, render(markdown)) });
        this.emitFile({ type: 'asset', fileName: `${dir}index.md`, source: absolute(markdown) });
      }
      for (const name of readdirSync(`${DOCS}img`)) {
        this.emitFile({ type: 'asset', fileName: `guide/img/${name}`, source: readFileSync(`${DOCS}img/${name}`) });
      }
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: sitemap() });
    },
  };
}
