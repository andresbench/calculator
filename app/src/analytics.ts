/**
 * Visit counts: GoatCounter on the project's own server (stats.andresbench.moe).
 *
 * No cookies and nothing stored in the browser. GoatCounter keeps the path,
 * the referrer, the browser and screen size, and the country; the IP only
 * makes a daily salted hash to tell a returning visitor from a new one.
 *
 * What is counted is chosen here, never taken from the address: the hash of
 * a shared link carries a whole rotation, and a showcase import a UID. So
 * paths are fixed names (`/track`, `/operator/Lifeng`) and events carry no
 * data of their own.
 *
 * The script loads in the production build only; GoatCounter itself also
 * ignores localhost.
 */

const ENDPOINT = 'https://stats.andresbench.moe/count';
const SCRIPT = 'https://stats.andresbench.moe/count.js';

interface Hit {
  path: string;
  title?: string;
  event?: boolean;
}

interface GoatCounter {
  count: (hit: Hit) => void;
}

declare global {
  interface Window {
    goatcounter?: GoatCounter & { no_onload?: boolean };
  }
}

const queue: Hit[] = [];
let state: 'off' | 'loading' | 'ready' = 'off';

function load(): void {
  if (state !== 'off' || !import.meta.env.PROD) return;
  state = 'loading';
  const script = document.createElement('script');
  script.async = true;
  script.src = SCRIPT;
  script.dataset.goatcounter = ENDPOINT;
  // The app counts its own screens; no automatic count on load.
  script.dataset.goatcounterSettings = JSON.stringify({ no_onload: true });
  script.onload = () => {
    state = 'ready';
    for (const hit of queue.splice(0)) window.goatcounter?.count(hit);
  };
  // Blocked or offline: counting is not worth an error.
  script.onerror = () => {
    queue.length = 0;
  };
  document.head.appendChild(script);
}

function send(hit: Hit): void {
  if (!import.meta.env.PROD) return;
  load();
  if (state === 'ready') window.goatcounter?.count(hit);
  else queue.push(hit);
}

/** A screen of the app, under a fixed path. */
export function countView(path: string, title?: string): void {
  send({ path, title: title ?? path });
}

/** Something done on the site; the name is the whole event. */
export type CountedEvent = 'enka-import' | 'rotation-link-copied' | 'rotation-link-opened' | 'rotation-downloaded';

export function countEvent(name: CountedEvent): void {
  send({ path: name, title: name, event: true });
}
