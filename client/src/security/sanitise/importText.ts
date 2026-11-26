/**
 * Text panel import conversion (T24 §5.4, T24-016, VIZ-056; plan #198 Part 2a §3.4, §4.2), called by
 * the importers (#158, #17). Pure: nothing is fetched.
 *
 * The conversion is **append-only**: each iframe with a `local` or `external` `src` becomes a
 * Markdown link inserted after its top-level block, and the iframe HTML stays (the renderer drops it).
 * Removing the `inserted` entries in ascending order, each at its `offset`, gives the input back.
 * Notes and errors carry at most a host, never content, URLs or values.
 */
import { Parser, type Node } from 'commonmark';
import { t } from '../../i18n/t';
import { findIframes } from './findIframes';
import { classifyUrl, type UrlClass } from './url';

export type ImportNote =
  | { kind: 'iframeToLink'; line: number; host: string }
  | { kind: 'iframeNoLink'; line: number }
  | { kind: 'htmlNotRendered'; count: number };

export interface Insertion {
  /** UTF-16 index in the input. */
  readonly offset: number;
  readonly text: string;
}

export type ImportTextResult =
  | {
      ok: true;
      content: string;
      notes: readonly ImportNote[];
      inserted: readonly Insertion[];
    }
  | { ok: false; reason: 'sizeLimit'; links: number };

export interface TextImportError {
  kind: 'textTooLargeForLinks';
  panelIndex: number;
  sourceId?: number;
  links: number;
}

/** The stored link label (content, not localised). */
export const embeddedLinkLabel = (host: string): string => `Open embedded page (${host})`;

/** The board spec's `content` limit (UTF-8 bytes; T24-003). */
const MAX_CONTENT_BYTES = 65_536;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/g;
const LINE_END = /\r\n|\n|\r/g;
const TERMINATOR = /[\r\n]/;
const BLANK = /^[ \t]*$/;

/** `[label](<href>)`: every ASCII punctuation character of the label escaped; `&`, `<`, `>`, `\` of the destination. */
export function markdownLink(label: string, href: string): string {
  const l = label.replace(ASCII_PUNCTUATION, '\\$&');
  const d = href.replace(/&/g, '&amp;').replace(/[<>\\]/g, '\\$&');
  return `[${l}](<${d}>)`;
}

interface Hit {
  readonly line: number;
  readonly top: Node;
  readonly src: string | null;
}

function topBlock(n: Node): Node {
  let b = n;
  while (b.parent !== null && b.parent.type !== 'document') b = b.parent;
  return b;
}

/** The start offset of each line (1-based line k starts at `starts[k - 1]`), as commonmark splits them. */
function lineStarts(content: string): number[] {
  const starts = [0];
  for (const m of content.matchAll(LINE_END)) starts.push(m.index + m[0].length);
  return starts;
}

/** The iframes of each `html_block`, and of each leaf block's `html_inline` literals joined. */
function collect(doc: Node): { hits: Hit[]; html: number } {
  const hits: Hit[] = [];
  let html = 0;
  let leaf: { node: Node; parts: string[] } | null = null;
  const w = doc.walker();
  for (let e = w.next(); e !== null; e = w.next()) {
    const n = e.node;
    if (n.type === 'paragraph' || n.type === 'heading') {
      if (e.entering) {
        leaf = { node: n, parts: [] };
      } else if (leaf !== null) {
        const line = n.sourcepos[0][0];
        const top = topBlock(n);
        for (const f of findIframes(leaf.parts.join(''))) hits.push({ line, top, src: f.src });
        leaf = null;
      }
    } else if (e.entering && n.type === 'html_block') {
      html++;
      const start = n.sourcepos[0][0];
      const top = topBlock(n);
      for (const f of findIframes(n.literal ?? '')) {
        hits.push({ line: start + f.line - 1, top, src: f.src });
      }
    } else if (e.entering && n.type === 'html_inline') {
      html++;
      leaf?.parts.push(n.literal ?? '');
    }
  }
  return { hits, html };
}

/** The text inserted at `e`: the links on their own line, as a block of their own. */
function insertion(content: string, e: number, links: string): string {
  // After a lone CR, a leading "\n" would join it as one CRLF terminator: use CR there.
  const nl = e > 0 && content[e - 1] === '\r' ? '\r' : '\n';
  const atEof = e >= content.length;
  const lead = atEof && e > 0 && !TERMINATOR.test(content[e - 1] ?? '') ? nl : '';
  const rest = content.slice(e);
  const end = rest.search(TERMINATOR);
  const next = end < 0 ? rest : rest.slice(0, end);
  return `${lead}${nl}${links}${nl}${atEof || BLANK.test(next) ? '' : nl}`;
}

/** Converts an imported Text panel's content (T24 §5.4). */
export function convertImportedText(
  content: string,
  mode: 'markdown' | 'code',
  appOrigin: string,
): ImportTextResult {
  if (mode === 'code') return { ok: true, content, notes: [], inserted: [] };
  const { hits, html } = collect(new Parser().parse(content));
  const notes: ImportNote[] = [];
  const groups = new Map<Node, string[]>();
  for (const h of hits) {
    const c: UrlClass = h.src === null ? { kind: 'rejected' } : classifyUrl(h.src, appOrigin);
    if (c.kind === 'local' || c.kind === 'external') {
      const links = groups.get(h.top) ?? [];
      links.push(markdownLink(embeddedLinkLabel(c.host), c.href));
      groups.set(h.top, links);
      notes.push({ kind: 'iframeToLink', line: h.line, host: c.host });
    } else {
      notes.push({ kind: 'iframeNoLink', line: h.line });
    }
  }
  // Array.prototype.sort is stable: hits on one line keep their order.
  notes.sort((a, b) => ('line' in a ? a.line : 0) - ('line' in b ? b.line : 0));
  if (html > 0) notes.push({ kind: 'htmlNotRendered', count: html });

  const starts = lineStarts(content);
  const inserted: Insertion[] = [];
  for (const [top, links] of groups) {
    const last = top.sourcepos[1][0];
    const e = starts[last] ?? content.length;
    inserted.push({ offset: e, text: insertion(content, e, links.join(' ')) });
  }
  inserted.sort((a, b) => a.offset - b.offset);

  let out = '';
  let at = 0;
  for (const x of inserted) {
    out += content.slice(at, x.offset) + x.text;
    at = x.offset;
  }
  out += content.slice(at);
  if (new TextEncoder().encode(out).length > MAX_CONTENT_BYTES) {
    return {
      ok: false,
      reason: 'sizeLimit',
      links: notes.filter((n) => n.kind === 'iframeToLink').length,
    };
  }
  return { ok: true, content: out, notes, inserted };
}

/** The report line of an import note (holds at most a host). */
export function importNoteMessage(n: ImportNote): string {
  switch (n.kind) {
    case 'iframeToLink':
      return t('import.text.iframeToLink', { line: n.line, host: n.host });
    case 'iframeNoLink':
      return t('import.text.iframeNoLink', { line: n.line });
    case 'htmlNotRendered':
      return t('import.text.htmlNotRendered', { count: n.count });
  }
}

/** The importer's message for a panel left out by the size limit: index, integer id and count only. */
export function textImportErrorMessage(e: TextImportError): string {
  return e.sourceId === undefined
    ? t('import.text.tooLargeNoId', { index: e.panelIndex, links: e.links })
    : t('import.text.tooLarge', { index: e.panelIndex, id: e.sourceId, links: e.links });
}
