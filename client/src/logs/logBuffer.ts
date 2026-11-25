/**
 * The client log buffer (plan #66 Part B §3.2, §4.3; PRF-020): a run's log lines as whole pages,
 * each holding the decoder's columns by reference, at most `MAX_ENTRIES` entries and
 * `MAX_TEXT_UNITS` UTF-16 code units of line text. Every entry has an ordinal, its position in
 * the run's page order, which never changes. The buffer keeps the cursor chain of every page it
 * has accepted, also after the page is evicted, so a page evicted at the far end is fetched again
 * with the same request and checked against what was seen (count, returned cursor and content
 * fingerprint): a mismatch is drift and changes nothing.
 */
import type { LogFrame, LogStreamInfo } from '../data/logFrame';

export const MAX_ENTRIES = 1_000_000;
/** Line text held, in UTF-16 code units (Q3: about 256 MiB). */
export const MAX_TEXT_UNITS = 2 ** 27;

/** Ordinals [from, to): positions in the run's page order. */
export interface OrdRange {
  readonly from: number;
  readonly to: number;
}

export interface LogRow {
  readonly ord: number;
  readonly tsNs: bigint;
  /** Index into LOG_LEVELS. */
  readonly level: number;
  readonly line: string;
  readonly stream: LogStreamInfo;
  /** The row's structured metadata, or null (the Inspector, #192). */
  readonly metadata: Readonly<Record<string, string>> | null;
  /** The row's parsed fields, or null (the Inspector, #192). */
  readonly parsed: Readonly<Record<string, string>> | null;
  /** Wrap width units: per code point, tab 8, U+1100 and above 2, LF 0, else 1. */
  readonly wrapUnits: number;
  /** LF count. Both computed per page on accept, in the fingerprint's pass. */
  readonly breaks: number;
}

/** One `kind: 'streams'` answer, as the pager hands it over. */
export interface PageResult {
  readonly frame: LogFrame;
  readonly cursor: string | null;
}

export type AcceptOutcome = 'first' | 'appended' | 'prepended' | 'drift' | 'stale';

export interface BufferCaps {
  readonly entries?: number;
  readonly textUnits?: number;
}

/** What is known of page k after its first accept: kept for the life of the run. */
interface PageRecord {
  readonly firstOrd: number;
  readonly count: number;
  readonly fingerprint: string;
  /** The cursor page k returned: the request cursor of page k + 1, or null at the end. */
  readonly next: string | null;
}

/** A held page: the frame's columns by reference and the per-row wrap measures. */
interface HeldPage {
  readonly k: number;
  readonly firstOrd: number;
  readonly count: number;
  readonly frame: LogFrame;
  readonly textUnits: number;
  readonly wrapUnits: Uint32Array;
  readonly breaks: Uint32Array;
}

/** One pass over a page: fingerprint, text units and wrap measures. */
interface Scanned {
  readonly fingerprint: string;
  readonly textUnits: number;
  readonly wrapUnits: Uint32Array;
  readonly breaks: Uint32Array;
}

const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');

/** The fingerprint hash: two 32-bit lanes over UTF-16 code units (seed 0). */
class Hasher {
  h1 = 0xdeadbeef;
  h2 = 0x41c6ce57;

  unit(c: number): void {
    this.h1 = Math.imul(this.h1 ^ c, 2654435761);
    this.h2 = Math.imul(this.h2 ^ c, 1597334677);
  }

  text(s: string): void {
    for (let i = 0; i < s.length; i += 1) this.unit(s.charCodeAt(i));
  }

  digest(): string {
    let h1 = this.h1;
    let h2 = this.h2;
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return hex8(h2) + hex8(h1);
  }
}

function scan(frame: LogFrame, measure: boolean): Scanned {
  const n = frame.lines.length;
  const h = new Hasher();
  const wrapUnits = new Uint32Array(measure ? n : 0);
  const breaks = new Uint32Array(measure ? n : 0);
  let textUnits = 0;
  for (let r = 0; r < n; r += 1) {
    const line = frame.lines[r] ?? '';
    h.text(String(frame.tsNs[r] ?? 0n));
    h.unit(0);
    h.text(frame.streams[frame.streamIndex[r] ?? 0]?.key ?? '');
    h.unit(0);
    h.text(String(frame.levels[r] ?? 0));
    h.unit(0);
    let units = 0;
    let lf = 0;
    for (let i = 0; i < line.length; i += 1) {
      const c = line.charCodeAt(i);
      h.unit(c);
      if (c === 10) lf += 1;
      else if (c === 9) units += 8;
      else if (c >= 0x1100) {
        units += 2;
        // A surrogate pair is one code point.
        if (c <= 0xdbff && c >= 0xd800) {
          const d = line.charCodeAt(i + 1);
          if (d >= 0xdc00 && d <= 0xdfff) {
            i += 1;
            h.unit(d);
          }
        }
      } else units += 1;
    }
    h.unit(1);
    textUnits += line.length;
    if (measure) {
      wrapUnits[r] = units;
      breaks[r] = lf;
    }
  }
  return { fingerprint: h.digest(), textUnits, wrapUnits, breaks };
}

/** An upper bound of a wrapped row's lines at `perLine` monospace columns: min(100, ceil(2 ×
 *  wrapUnits / perLine) + 1 + breaks). (A line ends early only when the next word does not fit, so
 *  a line and the next word together exceed perLine: at most 2·units/perLine + 1 lines per LF-free
 *  run.) Measured rows are therefore not taller than estimated, except for glyphs wider than two
 *  columns (hardPx catches those, §4.5). */
export function wrapLines(row: Pick<LogRow, 'wrapUnits' | 'breaks'>, perLine: number): number {
  return Math.min(100, Math.ceil((2 * row.wrapUnits) / Math.max(1, perLine)) + 1 + row.breaks);
}

/** 16 hex digits over the page's rows in page order: for each row the UTF-16 code units of
 *  `${tsNs}\u0000${streams[streamIndex].key}\u0000${level}\u0000${line}\u0001`, hashed with two
 *  32-bit lanes (seed 0). Recorded for every page on its first accept and compared on every
 *  re-fetch (§4.3). */
export function pageFingerprint(frame: LogFrame): string {
  return scan(frame, false).fingerprint;
}

export class LogBuffer {
  private readonly capEntries: number;
  private readonly capText: number;
  private readonly records: PageRecord[] = [];
  /** Held pages in page order: consecutive page indexes. */
  private readonly held: HeldPage[] = [];
  private entries = 0;
  private text = 0;

  constructor(caps: BufferCaps = {}) {
    this.capEntries = caps.entries ?? MAX_ENTRIES;
    this.capText = caps.textUnits ?? MAX_TEXT_UNITS;
  }

  /** Held ordinals [firstOrd, endOrd); both 0 when nothing is held. */
  get firstOrd(): number {
    return this.held[0]?.firstOrd ?? 0;
  }

  get endOrd(): number {
    const last = this.held.at(-1);
    return last === undefined ? 0 : last.firstOrd + last.count;
  }

  get length(): number {
    return this.entries;
  }

  get textUnits(): number {
    return this.text;
  }

  /** Held page indexes [headPage, tailPage). */
  get headPage(): number {
    return this.held[0]?.k ?? 0;
  }

  get tailPage(): number {
    const last = this.held.at(-1);
    return last === undefined ? 0 : last.k + 1;
  }

  /** Pages accepted at least once: 0 … knownPages − 1. */
  get knownPages(): number {
    return this.records.length;
  }

  /** The last known page answered without a cursor. */
  get exhausted(): boolean {
    return this.records.at(-1)?.next === null;
  }

  /** Entries of the whole run once exhausted, else null. */
  get total(): number | null {
    const last = this.records.at(-1);
    return last?.next === null ? last.firstOrd + last.count : null;
  }

  /** The request cursor of page k: null for page 0; undefined while page k is unreachable. */
  cursorOf(k: number): string | null | undefined {
    if (k === 0) return null;
    if (k < 0 || k > this.records.length) return undefined;
    return this.records[k - 1]?.next ?? undefined;
  }

  /** A held page has a row of stream `key` (the selection's relevance, T25-006). */
  hasStream(key: string): boolean {
    return this.held.some((p) => p.frame.streams.some((s) => s.key === key));
  }

  /** O(log pages). Null outside [firstOrd, endOrd). */
  rowAt(ord: number): LogRow | null {
    const held = this.held;
    let lo = 0;
    let hi = held.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const p = held[mid];
      if (p === undefined) return null;
      if (ord < p.firstOrd) hi = mid - 1;
      else if (ord >= p.firstOrd + p.count) lo = mid + 1;
      else {
        const r = ord - p.firstOrd;
        const f = p.frame;
        const stream = f.streams[f.streamIndex[r] ?? 0];
        if (stream === undefined) return null;
        return {
          ord,
          tsNs: f.tsNs[r] ?? 0n,
          level: f.levels[r] ?? 0,
          line: f.lines[r] ?? '',
          stream,
          metadata: f.metadata[r] ?? null,
          parsed: f.parsed[r] ?? null,
          wrapUnits: p.wrapUnits[r] ?? 0,
          breaks: p.breaks[r] ?? 0,
        };
      }
    }
    return null;
  }

  /** §4.3. `protect`: ordinals the view shows; their pages are not evicted. */
  accept(k: number, page: PageResult, protect: OrdRange | null): AcceptOutcome {
    const known = this.records.length;
    if (this.held.length === 0) {
      if (known !== 0 || k !== 0) return 'stale';
      const s = scan(page.frame, true);
      this.records.push(record(0, page, s));
      this.hold(heldOf(0, 0, page, s), 'tail');
      return 'first';
    }
    const tail = this.tailPage;
    if (k === tail && k === known) {
      if (this.cursorOf(k) === undefined) return 'stale';
      const s = scan(page.frame, true);
      const firstOrd = this.endOrd;
      this.records.push(record(firstOrd, page, s));
      this.hold(heldOf(k, firstOrd, page, s), 'tail');
      this.evict('head', protect);
      return 'appended';
    }
    if (k !== tail && k !== this.headPage - 1) return 'stale';
    const rec = this.records[k];
    if (rec === undefined) return 'stale';
    const s = scan(page.frame, true);
    if (
      page.frame.lines.length !== rec.count ||
      page.cursor !== rec.next ||
      s.fingerprint !== rec.fingerprint
    ) {
      return 'drift';
    }
    const at = k === tail ? 'tail' : 'head';
    this.hold(heldOf(k, rec.firstOrd, page, s), at);
    this.evict(at === 'tail' ? 'head' : 'tail', protect);
    return at === 'tail' ? 'appended' : 'prepended';
  }

  private hold(p: HeldPage, at: 'head' | 'tail'): void {
    if (at === 'tail') this.held.push(p);
    else this.held.unshift(p);
    this.entries += p.count;
    this.text += p.textUnits;
  }

  /** Drops pages at `end` while over a cap; never the page just added, never a protected page. */
  private evict(end: 'head' | 'tail', protect: OrdRange | null): void {
    while ((this.entries > this.capEntries || this.text > this.capText) && this.held.length > 1) {
      const p = end === 'head' ? this.held[0] : this.held.at(-1);
      if (p === undefined) return;
      const shown =
        protect !== null &&
        p.count > 0 &&
        p.firstOrd < protect.to &&
        protect.from < p.firstOrd + p.count;
      if (shown) return;
      if (end === 'head') this.held.shift();
      else this.held.pop();
      this.entries -= p.count;
      this.text -= p.textUnits;
    }
  }
}

function record(firstOrd: number, page: PageResult, s: Scanned): PageRecord {
  return {
    firstOrd,
    count: page.frame.lines.length,
    fingerprint: s.fingerprint,
    next: page.cursor,
  };
}

function heldOf(k: number, firstOrd: number, page: PageResult, s: Scanned): HeldPage {
  return {
    k,
    firstOrd,
    count: page.frame.lines.length,
    frame: page.frame,
    textUnits: s.textUnits,
    wrapUnits: s.wrapUnits,
    breaks: s.breaks,
  };
}
