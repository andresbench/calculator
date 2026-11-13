/**
 * Game names in the interface language.
 *
 * The bundle is English and stays English: synergy and the effects layer
 * match skills and sets by their English names, so the Russian ones never
 * replace anything in the data. They are looked up only where a name is
 * shown, from `bundle.ru.json` (official names: the wiki's `Cargo:Locales`
 * and the client's own text, `tools/ef/names_ru.py`). Missing → English.
 *
 * The file is fetched once, the first time Russian is chosen (`App`).
 */

import { useMemo } from 'react';
import { create } from 'zustand';

import { SCHEMA, type Bundle } from '@engine/index.js';

import { currentLang, useLang } from './index.js';

type Table = Record<string, string>;

interface RuNames {
  operators: Table;
  skills: Table;
  talents: Table;
  potentials: Table;
  weapons: Table;
  gear: Table;
  sets: Table;
  enemies: Table;
  terms: Table;
}

const VERSION = typeof __BUNDLE_VERSION__ === 'string' ? __BUNDLE_VERSION__ : '';

export const useRuNames = create<{ ru: RuNames | null; requested: boolean; load: () => void }>((set, get) => ({
  ru: null,
  requested: false,
  load: () => {
    if (get().requested) return;
    set({ requested: true });
    void (async () => {
      try {
        const url = VERSION ? `data/bundle.ru.json?v=${VERSION}` : 'data/bundle.ru.json';
        const response = await fetch(url);
        if (!response.ok) return;
        const payload = (await response.json()) as Partial<RuNames> & { schema?: number };
        if (payload.schema !== SCHEMA) return;
        set({
          ru: {
            operators: payload.operators ?? {},
            skills: payload.skills ?? {},
            talents: payload.talents ?? {},
            potentials: payload.potentials ?? {},
            weapons: payload.weapons ?? {},
            gear: payload.gear ?? {},
            sets: payload.sets ?? {},
            enemies: payload.enemies ?? {},
            terms: payload.terms ?? {},
          },
        });
      } catch {
        // No Russian names: English ones are shown, which is the fallback anyway.
        // A network error is not the answer "there is no file": the next call
        // (a language switch, a reload of the screen) asks again.
        set({ requested: false });
      }
    })();
  },
}));

export interface Names {
  operator: (key: string, fallback: string) => string;
  skill: (name: string) => string;
  talent: (name: string) => string;
  potential: (name: string) => string;
  weapon: (key: string, fallback: string) => string;
  gear: (key: string, fallback: string) => string;
  set: (key: string, fallback?: string) => string;
  enemy: (key: string, fallback: string) => string;
  /** Glossary terms, elements, classes, skill types, tags. */
  term: (name: string) => string;
}

const ENGLISH: Names = {
  operator: (_key, fallback) => fallback,
  skill: (name) => name,
  talent: (name) => name,
  potential: (name) => name,
  weapon: (_key, fallback) => fallback,
  gear: (_key, fallback) => fallback,
  set: (key, fallback) => fallback ?? key,
  enemy: (_key, fallback) => fallback,
  term: (name) => name,
};

function russian(ru: RuNames): Names {
  return {
    operator: (key, fallback) => ru.operators[key] ?? fallback,
    skill: (name) => ru.skills[name] ?? name,
    talent: (name) => ru.talents[name] ?? name,
    potential: (name) => ru.potentials[name] ?? name,
    weapon: (key, fallback) => ru.weapons[key] ?? fallback,
    gear: (key, fallback) => ru.gear[key] ?? fallback,
    set: (key, fallback) => ru.sets[key] ?? fallback ?? key,
    enemy: (key, fallback) => ru.enemies[key] ?? fallback,
    term: (name) => ru.terms[name] ?? name,
  };
}

/** Names for a component: re-renders when the language or the file arrives. */
export function useNames(): Names {
  const lang = useLang((state) => state.lang);
  const ru = useRuNames((state) => state.ru);
  return useMemo(() => (lang === 'ru' && ru ? russian(ru) : ENGLISH), [lang, ru]);
}

/** For helpers called while a component that used `useNames()` renders. */
export function currentNames(): Names {
  const { ru } = useRuNames.getState();
  return currentLang() === 'ru' && ru ? russian(ru) : ENGLISH;
}

/** An operator's shown name by key, with the bundle's English name as fallback. */
export function opName(bundle: Bundle, key: string): string {
  return currentNames().operator(key, bundle.operators[key]?.name ?? key);
}
