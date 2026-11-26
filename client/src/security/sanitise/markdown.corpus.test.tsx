/// <reference types="node" />
/**
 * unit:markdown-xss-corpus (plan #198 Part 2b §5, §5.1, §5.2; VIZ-054, VIZ-056, T18-013): every case
 * of the generated corpus `__fixtures__/xss-corpus.json`, under both policies, rendered with
 * `createRoot` in jsdom. The DOM's shape and the removals equal the generated expectation, every
 * DOM passes `checkInvariants`, and nothing makes a request. The checker itself is checked on
 * fixtures that must fail.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderMarkdown, type Removal, type RenderPolicy } from './markdown';
import styles from './markdown.module.css';
import { checkInvariants, fromDom, shapeOf, type TElement, type TNode } from './testInvariants';

interface Expectation {
  dom: string;
  removals: [Removal['kind'], number][];
}
interface Entry {
  id: string;
  src: string;
  vars: [string, string][];
  entity: string | null;
  expect: Record<RenderPolicy, Expectation>;
}

const FILE = join(process.cwd(), 'src', 'security', 'sanitise', '__fixtures__', 'xss-corpus.json');
const corpus = JSON.parse(readFileSync(FILE, 'utf8')) as { origin: string; cases: Entry[] };

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('unit:markdown-xss-corpus', () => {
  it('holds every group', () => {
    const groups = new Set(corpus.cases.map((c) => c.id.replace(/\d+$/, '')));
    expect([...groups].sort()).toEqual(['B', 'D', 'H', 'L', 'N', 'S', 'U', 'V']);
    expect(corpus.cases.length).toBeGreaterThan(300);
  });

  it('every case renders as generated, passes the invariants and makes no request', () => {
    const fetchSpy = vi.fn();
    const beacon = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const host = document.createElement('div');
    document.body.append(host);
    const failures: string[] = [];
    try {
      for (const c of corpus.cases) {
        for (const policy of ['board', 'ai'] as const) {
          const r = renderMarkdown(
            c.src,
            { vars: new Map(c.vars), entity: c.entity },
            { policy, appOrigin: corpus.origin },
          );
          const root = createRoot(host);
          act(() => {
            root.render(<>{r.node}</>);
          });
          const tree = fromDom(host);
          const exp = c.expect[policy];
          const shape = shapeOf(tree);
          if (shape !== exp.dom) failures.push(`${c.id} ${policy} dom ${shape} ≠ ${exp.dom}`);
          const removals = r.removals.map((x) => [x.kind, x.line]);
          if (JSON.stringify(removals) !== JSON.stringify(exp.removals)) {
            failures.push(`${c.id} ${policy} removals ${JSON.stringify(removals)}`);
          }
          for (const v of checkInvariants(tree, policy)) failures.push(`${c.id} ${policy} ${v}`);
          act(() => {
            root.unmount();
          });
        }
      }
    } finally {
      host.remove();
      vi.unstubAllGlobals();
    }
    expect(failures).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(beacon).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  }, 120_000);
});

describe('checkInvariants', () => {
  const el = (tag: string, attrs: Record<string, string>, ...children: TNode[]): TElement => ({
    kind: 'element',
    tag,
    attrs: new Map(Object.entries(attrs)),
    children,
  });
  const text = (value: string): TNode => ({ kind: 'text', value });
  const root = (...children: TNode[]): TElement => el('#root', {}, ...children);
  const A = { target: '_blank', rel: 'noopener noreferrer nofollow' };

  it('passes a kept local anchor under both policies', () => {
    const tree = root(el('p', {}, el('a', { href: '/b', ...A }, text('d'))));
    expect(checkInvariants(tree, 'board')).toEqual([]);
    expect(checkInvariants(tree, 'ai')).toEqual([]);
  });

  it('fails ai external and mailto anchors', () => {
    for (const href of ['https://x.test/p', 'mailto:o@x.test']) {
      const tree = root(el('p', {}, el('a', { href, ...A }, text('x'))));
      expect(checkInvariants(tree, 'board'), href).toEqual([]);
      expect(checkInvariants(tree, 'ai'), href).not.toEqual([]);
    }
  });

  it('fails bad hrefs, missing rel, img under ai, api images, stray spans, on* and depth', () => {
    const bad: [TElement, RenderPolicy][] = [
      [root(el('a', { href: 'javascript:x', ...A })), 'board'],
      [root(el('a', { href: '//e.test/x', ...A })), 'board'],
      [root(el('a', { href: '/b', target: '_blank' })), 'board'],
      [root(el('img', { src: '/l.svg', alt: '' })), 'ai'],
      [root(el('img', { src: '/%61pi/x', alt: '' })), 'board'],
      [root(el('span', {}, text('x'))), 'board'],
      [root(el('span', { class: styles['flat'] ?? 'flat' }, text('x'), text('y'))), 'board'],
      [root(el('p', { onclick: 'x' })), 'board'],
      [root(el('p', { style: 'x' })), 'board'],
      [root(el('div', {})), 'board'],
      [root(el('h1', {})), 'board'],
      [root(text('a\uD800')), 'board'],
      [root(Array.from({ length: 33 }).reduce<TNode>((n) => el('em', {}, n), text('x'))), 'board'],
    ];
    for (const [tree, policy] of bad) {
      expect(checkInvariants(tree, policy), JSON.stringify(shapeOf(tree))).not.toEqual([]);
    }
    expect(checkInvariants(root(el('h1', {})), 'board', { headingOffset: 0 })).toEqual([]);
  });
});
