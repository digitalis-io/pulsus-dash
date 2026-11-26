/// <reference types="node" />
/**
 * unit:find-iframes (plan #198 Part 2a §5; T24 §5.2, §10, T24-006). `SAXParser` (which needs
 * `node:stream`) is imported only here, as the reference for the tokens of the aliased
 * `ParserFeedbackSimulator` that `findIframes` drives.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Token, TokenHandler } from 'parse5';
import { SAXParser } from 'parse5-sax-parser';
import { describe, expect, it } from 'vitest';
import { findIframes } from './findIframes';

const W = '<iframe src=w>';
const X = '<iframe src=x>';

/** T24 §10 inputs with the `src` values found. */
const FOUND: [string, (string | null)[]][] = [
  ['<iframe data-src="a" src="b">', ['b']],
  [`<iframe title='src="x"'>`, [null]],
  ['<iframe src="b" SRC="c">', ['b']],
  ['<iframe src="?a&copy=1">', ['?a&copy=1']],
  ['<!-- x --!><iframe src=y>', ['y']],
  ['<!--><iframe src=z>', ['z']],
  [`<select>${W}`, ['w']],
  [`<table>${W}`, ['w']],
  [`<frameset>${W}`, ['w']],
  [`<template>${W}`, ['w']],
  [`<svg>${W}`, ['w']],
  [`<select><title><select>${W}`, ['w']],
  // The plan's additions: an SVG `style` is not raw text, and tag and attribute names fold case.
  ['<svg><style><iframe src=v>', ['v']],
  ['<IFRAME SRC=x>', ['x']],
];

/** T24 §10 inputs in which no iframe start tag exists. */
const NONE = [
  `<script>${X}`,
  `<textarea>${X}`,
  `<title>${X}`,
  `<style>${X}`,
  `<xmp>${X}`,
  `<plaintext>${X}`,
  `<![CDATA[${X}`,
  `<?x${X}`,
  `</ ${X}`,
  `<svg><![CDATA[${X}]]></svg>`,
];

type Tok = readonly [string, string, string, number | undefined];

function attrs(a: readonly Token.Attribute[]): string {
  return JSON.stringify(a.map((x) => [x.name, x.value]));
}

/** The tag, comment and doctype tokens of the reference `SAXParser`. */
async function saxTokens(html: string): Promise<Tok[]> {
  const out: Tok[] = [];
  const p = new SAXParser({ sourceCodeLocationInfo: true });
  p.on('startTag', (t) => {
    out.push([
      'start',
      t.tagName,
      attrs(t.attrs) + String(t.selfClosing),
      t.sourceCodeLocation?.startOffset,
    ]);
  });
  p.on('endTag', (t) => {
    out.push(['end', t.tagName, '', t.sourceCodeLocation?.startOffset]);
  });
  p.on('comment', (c) => {
    out.push(['comment', c.text, '', c.sourceCodeLocation?.startOffset]);
  });
  p.on('doctype', (d) => {
    out.push(['doctype', d.name ?? '', '', d.sourceCodeLocation?.startOffset]);
  });
  await new Promise<void>((resolve, reject) => {
    p.on('finish', resolve);
    p.on('error', reject);
    p.end(html);
  });
  return out;
}

interface Simulator {
  new (
    o: { sourceCodeLocationInfo: boolean },
    h: TokenHandler,
  ): { tokenizer: { write(s: string, last: boolean): void } };
}

/** The alias, imported by a non-literal specifier so that a missing alias fails this test only. */
const FEEDBACK = ['parse5-sax-parser', 'feedback'].join('/');

async function loadSimulator(): Promise<Simulator | null> {
  try {
    const m = (await import(/* @vite-ignore */ FEEDBACK)) as {
      ParserFeedbackSimulator?: Simulator;
    };
    return m.ParserFeedbackSimulator ?? null;
  } catch {
    return null;
  }
}

/** The same tokens from the aliased simulator. */
function simTokens(Sim: Simulator, html: string): Tok[] {
  const out: Tok[] = [];
  const noop = (): void => undefined;
  const h: TokenHandler = {
    onCharacter: noop,
    onNullCharacter: noop,
    onWhitespaceCharacter: noop,
    onEof: noop,
    onStartTag(t) {
      out.push([
        'start',
        t.tagName,
        attrs(t.attrs) + String(t.selfClosing),
        t.location?.startOffset,
      ]);
    },
    onEndTag(t) {
      out.push(['end', t.tagName, '', t.location?.startOffset]);
    },
    onComment(c) {
      out.push(['comment', c.data, '', c.location?.startOffset]);
    },
    onDoctype(d) {
      out.push(['doctype', d.name ?? '', '', d.location?.startOffset]);
    },
  };
  new Sim({ sourceCodeLocationInfo: true }, h).tokenizer.write(html, true);
  return out;
}

describe('unit:find-iframes', () => {
  it('finds the T24 §10 iframes, once each', () => {
    for (const [html, srcs] of FOUND) {
      expect(
        findIframes(html).map((h) => h.src),
        html,
      ).toEqual(srcs);
    }
  });

  it('finds none in raw text, RCDATA, CDATA, processing instructions or bogus comments', () => {
    for (const html of NONE) expect(findIframes(html), html).toEqual([]);
    expect(findIframes(`a\n${NONE[0] ?? ''}\n<iframe src="/b">`)).toEqual([]);
    expect(findIframes(`a\n\n<iframe src="/b">`)).toEqual([{ offset: 3, line: 3, src: '/b' }]);
  });

  it('gives offsets and lines, sorted, for several iframes', () => {
    expect(findIframes('<iframe src=a></iframe>\n<p><iframe src=b>')).toEqual([
      { offset: 0, line: 1, src: 'a' },
      { offset: 27, line: 2, src: 'b' },
    ]);
  });

  it('the aliased simulator gives SAXParser’s tokens, and findIframes holds every SAX iframe', async () => {
    const Sim = await loadSimulator();
    expect(Sim, 'parse5-sax-parser/feedback resolves through the Vite alias').not.toBeNull();
    if (Sim === null) return;
    for (const html of [...FOUND.map(([h]) => h), ...NONE]) {
      const sax = await saxTokens(html);
      expect(simTokens(Sim, html), html).toEqual(sax);
      const hits = findIframes(html);
      for (const [kind, name, , offset] of sax) {
        if (kind === 'start' && name === 'iframe') {
          expect(
            hits.some((h) => h.offset === offset),
            html,
          ).toBe(true);
        }
      }
    }
  });

  it('the aliased file and its relative imports name no node: module', () => {
    const file = join(
      process.cwd(),
      'node_modules',
      'parse5-sax-parser',
      'dist',
      'parser-feedback-simulator.js',
    );
    const seen = new Set<string>();
    const visit = (f: string): void => {
      if (seen.has(f)) return;
      seen.add(f);
      const src = readFileSync(f, 'utf8');
      const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1] ?? '',
      );
      for (const s of specs) {
        expect(s.startsWith('node:') || s === 'stream', `${f}: ${s}`).toBe(false);
        if (s.startsWith('.')) visit(join(dirname(f), s));
      }
    };
    visit(file);
    expect([...seen]).toHaveLength(1);
    // The plain package entry is the one that needs node:stream.
    expect(readFileSync(join(dirname(file), 'index.js'), 'utf8')).toContain("from 'node:stream'");
    // findIframes uses the alias, never the package entry.
    const own = readFileSync(
      join(process.cwd(), 'src', 'security', 'sanitise', 'findIframes.ts'),
      'utf8',
    );
    expect(own).toContain("from 'parse5-sax-parser/feedback'");
    expect(own).not.toMatch(/from 'parse5-sax-parser'/);
  });
});
