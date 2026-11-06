/**
 * The interface language.
 *
 * Picked from the browser on the first visit, then remembered in
 * `localStorage` (a per-viewer convenience: a blocked storage just means
 * asking the browser again). Components read strings through `useT()`, which
 * also re-renders them when the language changes. Helpers called while such
 * a component renders — tooltips, message formatting — use `currentT()`.
 */

import { create } from 'zustand';

import { en, type Strings } from './en.js';
import { ru } from './ru.js';

export type Lang = 'en' | 'ru';
export const LANGS: Lang[] = ['en', 'ru'];

const KEY = 'andresbench.lang';
const DICTS: Record<Lang, Strings> = { en, ru };

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === 'en' || saved === 'ru') return saved;
  } catch {
    // Storage blocked: fall through to the browser's language.
  }
  return typeof navigator !== 'undefined' && navigator.language?.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

interface LangState {
  lang: Lang;
  setLang: (lang: Lang) => void;
}

export const useLang = create<LangState>((set) => ({
  lang: initial(),
  setLang: (lang) => {
    try {
      localStorage.setItem(KEY, lang);
    } catch {
      // Not remembered this time; the choice still applies.
    }
    set({ lang });
  },
}));

export function useT(): Strings {
  return DICTS[useLang((state) => state.lang)];
}

export function currentT(): Strings {
  return DICTS[useLang.getState().lang];
}

export function currentLang(): Lang {
  return useLang.getState().lang;
}

export type { Strings };
