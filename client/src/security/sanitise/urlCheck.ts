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

/** True iff `src` is `local` and its decoded path is not `/api`, `/auth` or under them. */
export function checkImgSrc(src: string): boolean {
  if (checkHref(src) !== 'local') return false;
  const d = decodedView(src);
  const cut = d.search(/[?#]/);
  return !API.test(cut < 0 ? d : d.slice(0, cut));
}

/** The host of an `external` href (lower-cased authority), for the `ai` link text. */
export function hrefHost(href: string): string {
  const d = decodedView(href);
  const m = SCHEME.exec(d);
  if (m === null) return '';
  const auth = d.slice((m[1] ?? '').length + 3).split(/[/?#]/)[0] ?? '';
  return auth.replace(/:(?:80|443)$/, '');
}
