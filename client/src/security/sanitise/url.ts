/**
 * URL classification for links, images and imported iframes (T24-005, T18-011; plan #198 Part 2a
 * §3.1). Pure: no step makes a network request or a DNS lookup, and `classifyUrl` never throws.
 *
 * `raw` first passes `toWellFormed`. The steps then run in order, and the first match decides:
 * 1. a match of `URL_FORBIDDEN` (C0 controls, space, DEL, C1 controls, `\`) → rejected;
 * 2. `/`-leading: `new URL(raw, appOrigin)` → `local` iff it is same-origin and its pathname does
 *    not start with `//`, with the path-relative href `pathname + search + hash`;
 * 3. `http(s):` without credentials → `external` with the parsed href; `mailto:` → `mailto`;
 * 4. anything else (other schemes, relative paths, `#…`, `''`) → rejected.
 */

export type UrlClass =
  | { kind: 'local'; href: string; host: string }
  | { kind: 'external'; href: string; host: string }
  | { kind: 'mailto'; href: string }
  | { kind: 'rejected' };

// The control ranges are the point of the pattern (T24 §5.2).
// eslint-disable-next-line no-control-regex
export const URL_FORBIDDEN = /[\u0000- \u007F-\u009F\\]/;

const ABSOLUTE = /^(https?|mailto):/i;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REJECTED: UrlClass = { kind: 'rejected' };

/**
 * `s` with every lone surrogate replaced by U+FFFD (as `String.prototype.toWellFormed`, which the
 * ES2023 lib lacks), so that URL parsing and `encodeURIComponent` never see one.
 */
export function toWellFormed(s: string): string {
  return s.replace(LONE_SURROGATE, '�');
}

function parse(raw: string, base?: string): URL | null {
  try {
    return base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
}

/** Classifies `raw` against the app origin (T24-005). */
export function classifyUrl(raw: string, appOrigin: string): UrlClass {
  const s = toWellFormed(raw);
  if (URL_FORBIDDEN.test(s)) return REJECTED;
  if (s.startsWith('/')) {
    const app = parse(appOrigin);
    const u = parse(s, appOrigin);
    if (app === null || u === null) return REJECTED;
    if (u.origin !== app.origin || u.pathname.startsWith('//')) return REJECTED;
    return { kind: 'local', href: u.pathname + u.search + u.hash, host: u.host };
  }
  if (ABSOLUTE.test(s)) {
    const u = parse(s);
    if (u === null) return REJECTED;
    if (u.protocol === 'mailto:') return { kind: 'mailto', href: u.href };
    if (u.username !== '' || u.password !== '') return REJECTED;
    return { kind: 'external', href: u.href, host: u.host };
  }
  return REJECTED;
}
