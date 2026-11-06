/**
 * Engine messages as text for the interface.
 *
 * The engine emits codes with parameters (`@engine/messages`); this is the
 * one place the app turns them into words, in the current language.
 * Operators are shown by their names from the bundle.
 */

import { EN_MESSAGES, formatMessage, type Bundle, type Message } from '@engine/index.js';

import { currentLang } from './i18n/index.js';
import { currentNames } from './i18n/names.js';
import { RU_MESSAGES } from './i18n/messages.ru.js';

export function say(bundle: Bundle, message: Message): string {
  const catalog = currentLang() === 'ru' ? RU_MESSAGES : EN_MESSAGES;
  const names = currentNames();
  return formatMessage(message, { name: (key) => names.operator(key, bundle.operators[key]?.name ?? key) }, catalog);
}
