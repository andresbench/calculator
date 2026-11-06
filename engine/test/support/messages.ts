/**
 * Messages as English text, for assertions that read like the track does.
 * Test operators are keyed by their names, so no name lookup is needed.
 */

import { formatMessage, type Message } from '../../src/index.js';

export const text = (message: Message | undefined): string | undefined =>
  message ? formatMessage(message) : undefined;

export const texts = (messages: Message[]): string[] => messages.map((message) => formatMessage(message));
