/**
 * fuzz:markdown-nodes (plan #198 Part 2b §5; T24 §10; VIZ-054, VIZ-056): 10 000 seeded inputs
 * (mulberry32, seed 20261125), each 1–40 tokens from the corpus payload lists, Markdown syntax,
 * `$env`, `{{entity}}` and U+0000/U+202E/U+D800. Each input renders under both policies (through
 * `renderToStaticMarkup` and `parse5.parseFragment`) and must pass `checkInvariants`. Then the
 * import: an `ok` conversion is undone exactly by its `inserted` list, and its result passes the
 * invariants too; `sizeLimit` is allowed only above 65 536 bytes. A failure names the input index.
 */
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { convertImportedText } from './importText';
import { renderMarkdown, type RenderPolicy } from './markdown';
import { checkInvariants, type TElement, type TNode } from './testInvariants';
import { BREAKOUTS, DEEP, HTML, IMAGES, NESTED_DESTS, SCHEMES, UNICODE, VALUES } from './xssCorpus';

const APP = 'https://dash.test';
const SEED = 20261125;
const INPUTS = 10_000;
const LIMIT = 65_536;

const TOKENS: readonly string[] = [
  ...SCHEMES,
  ...HTML,
  ...BREAKOUTS,
  ...VALUES,
  ...IMAGES,
  ...NESTED_DESTS,
  ...DEEP,
  ...UNICODE,
  '[',
  '](',
  '![',
  '<',
  '>',
  '*',
  '`',
  '\n',
  '- ',
  '> ',
  '#',
  ')',
  ' ',
  'a',
  '$env',
  '{{entity}}',
  '\u0000',
  '‮',
  '\uD800',
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fromParse5(frag: DefaultTreeAdapterTypes.DocumentFragment): TElement {
  const conv = (n: DefaultTreeAdapterTypes.ChildNode): TNode | null => {
    if (n.nodeName === '#text' && 'value' in n) return { kind: 'text', value: n.value };
    if (!('tagName' in n)) return null;
    return {
      kind: 'element',
      tag: n.tagName,
      attrs: new Map(n.attrs.map((a) => [a.name, a.value])),
      children: n.childNodes.map(conv).filter((x): x is TNode => x !== null),
    };
  };
  return {
    kind: 'element',
    tag: '#root',
    attrs: new Map(),
    children: frag.childNodes.map(conv).filter((x): x is TNode => x !== null),
  };
}

let rendered = 0;

function check(src: string, entity: string | null, policy: RenderPolicy): string[] {
  const r = renderMarkdown(
    src,
    { vars: new Map([['env', 'prod']]), entity },
    { policy, appOrigin: APP },
  );
  const html = renderToStaticMarkup(createElement(Fragment, null, r.node));
  if (html !== '') rendered++;
  return checkInvariants(fromParse5(parseFragment(html)), policy);
}

function inverse(out: string, inserted: readonly { offset: number; text: string }[]): string {
  let s = out;
  for (const x of inserted) s = s.slice(0, x.offset) + s.slice(x.offset + x.text.length);
  return s;
}

describe('fuzz:markdown-nodes', () => {
  it('10 000 seeded inputs pass the invariants, and the import inverse holds', () => {
    const rand = mulberry32(SEED);
    const failures: string[] = [];
    for (let i = 0; i < INPUTS && failures.length < 20; i++) {
      const n = 1 + Math.floor(rand() * 40);
      let src = '';
      for (let k = 0; k < n; k++) src += TOKENS[Math.floor(rand() * TOKENS.length)] ?? '';
      const entity = i % 2 === 0 ? null : 'svc';
      for (const policy of ['board', 'ai'] as const) {
        for (const v of check(src, entity, policy)) failures.push(`#${String(i)} ${policy}: ${v}`);
      }
      const imp = convertImportedText(src, 'markdown', APP);
      if (imp.ok) {
        if (inverse(imp.content, imp.inserted) !== src)
          failures.push(`#${String(i)} import inverse`);
        for (const v of check(imp.content, entity, 'board'))
          failures.push(`#${String(i)} import: ${v}`);
      } else {
        // An input is at most 40 tokens (a few KB) and each link is shorter than it, so no
        // conversion can pass the limit: a sizeLimit here is below 65 536 bytes.
        const bytes = new TextEncoder().encode(src).length * (imp.links + 2);
        if (bytes <= LIMIT) failures.push(`#${String(i)} sizeLimit below ${String(LIMIT)} bytes`);
      }
    }
    expect(failures).toEqual([]);
    // A renderer that drops everything passes the invariants trivially: most inputs render.
    expect(rendered).toBeGreaterThan(INPUTS);
  }, 300_000);
});
