/**
 * A rotation in a link.
 *
 * The site is static, with no server to keep anything on, so the link carries
 * the `.rot` text itself: deflated and base64url-encoded into the address
 * fragment, `#track?rot=…`. The fragment never reaches a server, and a
 * rotation of twenty steps fits in a few hundred characters.
 *
 * The text, not the draft, goes into the link: `.rot` is the format the
 * repository and the parser already agree on, and a link made today has to
 * open after the draft's shape changes.
 */

const PARAM = 'rot';

/**
 * What a shared rotation may inflate to. A real one is a few KB of `.rot`;
 * deflate packs a megabyte of one letter into a kilobyte, and the tab used to
 * hang unpacking such a link. Past this the link is refused as a bad link.
 */
const MAX_INFLATED = 256 * 1024;

async function pipe(
  bytes: Uint8Array<ArrayBuffer>,
  stream: CompressionStream | DecompressionStream,
  limit = Infinity,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error(`more than ${limit} bytes`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function encodeRot(text: string): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw')));
}

export async function decodeRot(data: string): Promise<string> {
  return new TextDecoder().decode(await pipe(fromBase64Url(data), new DecompressionStream('deflate-raw'), MAX_INFLATED));
}

/** The link that opens this rotation on the track. */
export async function shareUrl(text: string): Promise<string> {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#track?${PARAM}=${await encodeRot(text)}`;
}

/** The encoded rotation in a `#track?rot=…` fragment, or `null`. */
export function rotFromHash(hash: string): string | null {
  const query = hash.split('?')[1];
  return query ? new URLSearchParams(query).get(PARAM) : null;
}
