/**
 * Test-only: the independent URL checker of the XSS corpus and the fuzz (plan #198 Part 2b §5.2).
 * It imports neither `url.ts` nor `URL`, so a bug in `classifyUrl` cannot hide in both.
 *
 * - R (raw view): ASCII whitespace and C0/C1 controls stripped, `\` → `/`, and the `.` and `..`
 *   segments of a `/`-leading path resolved (their `%2e` forms too).
 * - D (decoded view): R percent-decoded until stable (at most 3 rounds; invalid sequences are
 *   kept), then lower-cased.
 *
 * This module has no imports: the corpus generator (`scripts/gen-xss-corpus.ts`) loads it in Node.
 */

export type HrefClass = 'local' | 'external' | 'mailto' | 'bad';

// The control ranges are the point of the pattern.
// eslint-disable-next-line no-control-regex
const STRIP = /[\u0000- \u007F-\u009F]/g;
const SCHEME = /^([a-z][a-z0-9+.-]*):/;
const PCT_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const API = /^\/(?:api|auth)(?:\/|$)/;

function resolveDots(path: string): string {
  const segs = path.slice(1).split('/');
  const out: string[] = [];
  let trailing = false;
  for (const seg of segs) {
    const s = seg.replace(/%2e/gi, '.');
    trailing = false;
    if (s === '.') {
      trailing = true;
    } else if (s === '..') {
      out.pop();
      trailing = true;
    } else {
      out.push(seg);
    }
  }
  return `/${out.join('/')}${trailing && out.length > 0 ? '/' : ''}`;
}

/** The raw view R. */
export function rawView(href: string): string {
  const s = href.replace(STRIP, '').replace(/\\/g, '/');
  if (!s.startsWith('/')) return s;
  const cut = s.search(/[?#]/);
  const path = cut < 0 ? s : s.slice(0, cut);
  const rest = cut < 0 ? '' : s.slice(cut);
  return resolveDots(path) + rest;
}

function decodeOnce(s: string): string {
  return s.replace(PCT_RUN, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/** The decoded view D. */
export function decodedView(href: string): string {
  let s = rawView(href);
  for (let i = 0; i < 3; i++) {
    const next = decodeOnce(s);
    if (next === s) break;
    s = next;
  }
  return s.toLowerCase();
}

/** The class of a rendered or expected `href` (plan §5.2). */
export function checkHref(href: string): HrefClass {
  const r = rawView(href);
  const d = decodedView(href);
  const m = SCHEME.exec(d);
  if (m !== null) {
    const scheme = m[1] ?? '';
    if (scheme === 'mailto') return 'mailto';
    if (scheme !== 'http' && scheme !== 'https') return 'bad';
    const rest = d.slice(scheme.length + 1);
    if (!rest.startsWith('//')) return 'bad';
    const authority = rest.slice(2).split(/[/?#]/)[0] ?? '';
    return authority !== '' && !authority.includes('@') ? 'external' : 'bad';
  }
  if (r.startsWith('/') && !r.startsWith('//')) return 'local';
  return 'bad';
}

const HEX = '0123456789abcdef';

/** The UTF-8 bytes of `s`, written out by hand. */
function utf8(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

function hexValue(b: number | undefined): number {
  return b === undefined ? -1 : HEX.indexOf(String.fromCharCode(b).toLowerCase());
}

/** One percent-decoding round over bytes; `changed` is whether any `%XX` was decoded. */
function pctRound(bytes: readonly number[]): { bytes: number[]; changed: boolean } {
  const out: number[] = [];
  let changed = false;
  let i = 0;
  while (i < bytes.length) {
    const hi = bytes[i] === 37 ? hexValue(bytes[i + 1]) : -1;
    const lo = hi >= 0 ? hexValue(bytes[i + 2]) : -1;
    if (lo >= 0) {
      out.push(hi * 16 + lo);
      changed = true;
      i += 3;
    } else {
      out.push(bytes[i] ?? 0);
      i += 1;
    }
  }
  return { bytes: out, changed };
}

/** True if `bytes` is well-formed UTF-8 (no overlongs, surrogates or values above U+10FFFF). */
function validUtf8(bytes: readonly number[]): boolean {
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i] ?? 0;
    let need = 0;
    let min = 0;
    let cp = 0;
    if (b < 0x80) {
      i += 1;
      continue;
    } else if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      min = 0x80;
      cp = b & 31;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      min = 0x800;
      cp = b & 15;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      min = 0x10000;
      cp = b & 7;
    } else {
      return false;
    }
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 63);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/**
 * True iff `src` is `local` and its path is not a server route: R's path is percent-decoded at the
 * byte level (up to 3 rounds), and `/api`, `/auth` or a path under them (ASCII case-insensitive),
 * a path still changing after 3 rounds, or one that is not valid UTF-8 all fail.
 */
export function checkImgSrc(src: string): boolean {
  if (checkHref(src) !== 'local') return false;
  const r = rawView(src);
  const cut = r.search(/[?#]/);
  let bytes = utf8(cut < 0 ? r : r.slice(0, cut));
  let rounds = 0;
  for (let step = pctRound(bytes); step.changed; step = pctRound(bytes)) {
    if (rounds === 3) return false;
    bytes = step.bytes;
    rounds++;
  }
  if (!validUtf8(bytes)) return false;
  const path = String.fromCharCode(...bytes.map((b) => (b >= 65 && b <= 90 ? b + 32 : b)));
  return !API.test(path);
}

/** The host of an `external` href (lower-cased authority), for the `ai` link text. */
export function hrefHost(href: string): string {
  const d = decodedView(href);
  const m = SCHEME.exec(d);
  if (m === null) return '';
  const auth = d.slice((m[1] ?? '').length + 3).split(/[/?#]/)[0] ?? '';
  return auth.replace(/:(?:80|443)$/, '');
}
