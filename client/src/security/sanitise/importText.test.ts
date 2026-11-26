/// <reference types="node" />
/**
 * unit:import-text-iframe, unit:import-size-error (plan #198 Part 2a §5; T24 §5.4, §10; VIZ-056,
 * T24-016). The fixtures are `api/fixtures/import/text-iframe.json` (vitest runs in `client/`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Parser, type Node } from 'commonmark';
import { describe, expect, it } from 'vitest';
import {
  convertImportedText,
  embeddedLinkLabel,
  importNoteMessage,
  markdownLink,
  textImportErrorMessage,
  type ImportNote,
  type TextImportError,
} from './importText';

interface Inserted {
  offset: number;
  text: string;
}
type Expected =
  | {
      ok: true;
      inserted: Inserted[];
      notes: ImportNote[];
      hrefs: string[];
      bytes?: number;
      types?: string[];
    }
  | { ok: false; reason: 'sizeLimit'; links: number };
interface Case {
  id: string;
  mode?: 'markdown' | 'code';
  content: string | { repeat: [string, number][] };
  result: Expected;
}

const FIXTURE = join(process.cwd(), '..', 'api', 'fixtures', 'import', 'text-iframe.json');
const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { origin: string; cases: Case[] };
const APP = fixture.origin;

function text(c: Case): string {
  return typeof c.content === 'string'
    ? c.content
    : c.content.repeat.map(([s, n]) => s.repeat(n)).join('');
}

function byId(id: string): Case {
  const c = fixture.cases.find((x) => x.id === id);
  if (c === undefined) throw new Error(`fixture ${id} missing`);
  return c;
}

/** Removes the inserted texts in ascending offset order, each at its offset. */
function inverse(out: string, inserted: readonly Inserted[]): string {
  let s = out;
  for (const x of inserted) {
    expect(s.slice(x.offset, x.offset + x.text.length)).toBe(x.text);
    s = s.slice(0, x.offset) + s.slice(x.offset + x.text.length);
  }
  return s;
}

function links(src: string): Node[] {
  const w = new Parser().parse(src).walker();
  const out: Node[] = [];
  for (let e = w.next(); e !== null; e = w.next()) {
    if (e.entering && e.node.type === 'link') out.push(e.node);
  }
  return out;
}

function topTypes(src: string): string[] {
  const out: string[] = [];
  for (let n = new Parser().parse(src).firstChild; n !== null; n = n.next) out.push(n.type);
  return out;
}

const IDS = ['f1', 'f3', 'f4', 'f5', 'f6', 'f6-over', 'f6-code', 'f7', 'f8', 'f9', 'f10'];

describe('unit:import-text-iframe', () => {
  it('has the T24 §10 fixtures f1, f3–f12', () => {
    expect(fixture.cases.map((c) => c.id).sort()).toEqual(
      [...IDS, 'f11-crlf', 'f11-cr', 'f12'].sort(),
    );
  });

  for (const c of fixture.cases) {
    it(`${c.id}: exact inserted and notes; removing inserted gives the input`, () => {
      const input = text(c);
      const r = convertImportedText(input, c.mode ?? 'markdown', APP);
      const want = c.result;
      if (!want.ok) {
        expect(r).toEqual(want);
        return;
      }
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.inserted).toEqual(want.inserted);
      expect(r.notes).toEqual(want.notes);
      expect(inverse(r.content, r.inserted)).toBe(input);
      expect(links(r.content).map((l) => l.destination)).toEqual(want.hrefs);
      if (want.bytes !== undefined) {
        expect(new TextEncoder().encode(r.content).length).toBe(want.bytes);
      }
      if (want.types !== undefined) expect(topTypes(r.content)).toEqual(want.types);
    });
  }

  it('f11: CRLF and CR line ends give f1’s notes and link texts, each a link node', () => {
    const f1 = convertImportedText(text(byId('f1')), 'markdown', APP);
    expect(f1.ok).toBe(true);
    if (!f1.ok) return;
    for (const id of ['f11-crlf', 'f11-cr']) {
      const input = text(byId(id));
      const r = convertImportedText(input, 'markdown', APP);
      expect(r.ok, id).toBe(true);
      if (!r.ok) continue;
      expect(r.notes, id).toEqual(f1.notes);
      expect(
        r.inserted.map((x) => x.text.trim()),
        id,
      ).toEqual(f1.inserted.map((x) => x.text.trim()));
      for (const x of r.inserted) expect('\r\n'.includes(input[x.offset - 1] ?? ''), id).toBe(true);
      expect(inverse(r.content, r.inserted), id).toBe(input);
      expect(
        links(r.content).map((l) => l.destination),
        id,
      ).toEqual(['https://x.test/a)b?q=%5B1%5D&r=%3C2%3E', 'https://intended.test/']);
    }
  });

  it('f12: each link follows its top-level block; the next paragraph stays a paragraph', () => {
    const r = convertImportedText(text(byId('f12')), 'markdown', APP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(topTypes(r.content)).toEqual([
      'list',
      'paragraph',
      'paragraph',
      'block_quote',
      'paragraph',
      'paragraph',
    ]);
    const ls = links(r.content);
    expect(ls.map((l) => l.destination)).toEqual(['https://li.test/', 'https://bq.test/']);
    for (const l of ls) expect(l.parent?.parent?.type).toBe('document');
  });

  it('markdownLink escapes label punctuation and the destination', () => {
    expect(markdownLink(embeddedLinkLabel('x.test'), 'https://x.test/a)b?q=[1]&r=%3C2%3E')).toBe(
      '[Open embedded page \\(x\\.test\\)](<https://x.test/a)b?q=[1]&amp;r=%3C2%3E>)',
    );
    expect(markdownLink('a*b_[c]', 'https://x.test/<p>\\q')).toBe(
      '[a\\*b\\_\\[c\\]](<https://x.test/\\<p\\>\\\\q>)',
    );
    const [l] = links(markdownLink('a', 'https://x.test/?a=&amp;b'));
    expect(l?.destination).toBe('https://x.test/?a=&amp;b');
  });
});

describe('unit:import-size-error', () => {
  const head = '# Payroll\n\n<iframe src="https://x.test/?token=SECRET123"></iframe>\n\n';
  const panel = head + 'p'.repeat(65_500 - head.length - 1) + '\n';

  it('a 65 500-byte panel with a link over the limit is a sizeLimit error with no content', () => {
    expect(new TextEncoder().encode(panel).length).toBe(65_500);
    const r = convertImportedText(panel, 'markdown', APP);
    expect(r).toEqual({ ok: false, reason: 'sizeLimit', links: 1 });
    if (r.ok) return;
    const err: TextImportError = {
      kind: 'textTooLargeForLinks',
      panelIndex: 3,
      sourceId: 12,
      links: r.links,
    };
    const msg = textImportErrorMessage(err);
    expect(msg).toBe(
      'Text panel #3 (id 12) is too large to add embedded-page links (1 links). Shorten or split it in the source and import again.',
    );
    for (const s of [JSON.stringify(r), JSON.stringify(err), msg]) {
      expect(s).not.toContain('SECRET123');
      expect(s).not.toContain('Payroll');
    }
  });

  it('the message without an id omits it', () => {
    expect(textImportErrorMessage({ kind: 'textTooLargeForLinks', panelIndex: 2, links: 4 })).toBe(
      'Text panel #2 is too large to add embedded-page links (4 links). Shorten or split it in the source and import again.',
    );
  });

  it('each note message holds at most a host', () => {
    const notes: ImportNote[] = [
      { kind: 'iframeToLink', line: 4, host: 'x.test' },
      { kind: 'iframeNoLink', line: 10 },
      { kind: 'htmlNotRendered', count: 3 },
    ];
    expect(notes.map(importNoteMessage)).toEqual([
      'Line 4: the embedded page from x.test became a link.',
      "Line 10: an embedded page without a usable address isn't shown.",
      "HTML isn't shown (3 elements).",
    ]);
    const r = convertImportedText(text(byId('f1')), 'markdown', APP);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const n of r.notes) {
      const m = importNoteMessage(n) + JSON.stringify(n);
      for (const bad of ['https:', 'javascript', '/a)b', 'q=', 'iframe src']) {
        expect(m).not.toContain(bad);
      }
    }
  });
});
