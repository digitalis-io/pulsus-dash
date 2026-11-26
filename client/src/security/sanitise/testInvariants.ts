/**
 * Test-only: the security invariants of a rendered Markdown tree (plan #198 Part 2b §5.2) and the
 * corpus shape of a tree. Works on `TNode`, so a jsdom DOM (`fromDom`) and a parse5 fragment (the
 * fuzz's adapter) are checked by the same code. URLs are checked by `urlCheck.ts`, never by
 * `classifyUrl`.
 */
import { t } from '../../i18n/t';
import styles from './markdown.module.css';
import { checkHref, checkImgSrc } from './urlCheck';

export interface TElement {
  readonly kind: 'element';
  readonly tag: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: readonly TNode[];
}
export interface TText {
  readonly kind: 'text';
  readonly value: string;
}
export type TNode = TElement | TText;

export type Policy = 'board' | 'ai';

/** The root's element children are depth 1 (plan §4.3). */
const MAX_DOM_DEPTH = 32;

const BASE_TAGS = [
  'p',
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'pre',
  'code',
  'br',
  'em',
  'strong',
  'a',
  'img',
  'span',
];
const ATTRS = new Set([
  'href',
  'target',
  'rel',
  'src',
  'alt',
  'loading',
  'start',
  'data-lang',
  'class',
  'aria-hidden',
]);
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A container (the render root) as a `TNode` tree of its children. */
export function fromDom(root: Node): TElement {
  const conv = (n: Node): TNode | null => {
    if (n.nodeType === 3) return { kind: 'text', value: n.nodeValue ?? '' };
    if (n.nodeType !== 1) return null;
    const el = n as Element;
    const attrs = new Map<string, string>();
    for (const a of Array.from(el.attributes)) attrs.set(a.name, a.value);
    return { kind: 'element', tag: el.tagName.toLowerCase(), attrs, children: kids(el) };
  };
  const kids = (n: Node): TNode[] =>
    Array.from(n.childNodes)
      .map(conv)
      .filter((x): x is TNode => x !== null);
  return { kind: 'element', tag: '#root', attrs: new Map(), children: kids(root) };
}

function isGlyph(e: TElement, parent: TElement | null): boolean {
  return (
    e.tag === 'span' &&
    parent?.tag === 'a' &&
    e.attrs.get('aria-hidden') === 'true' &&
    e.children.length === 0
  );
}

function isHiddenText(e: TElement, parent: TElement | null): boolean {
  const [c, ...rest] = e.children;
  return (
    e.tag === 'span' &&
    parent?.tag === 'a' &&
    e.attrs.get('class') === styles['srOnly'] &&
    rest.length === 0 &&
    c?.kind === 'text' &&
    c.value === t('markdown.newTab')
  );
}

function isFlat(e: TElement): boolean {
  const [c, ...rest] = e.children;
  return (
    e.tag === 'span' &&
    e.attrs.get('class') === styles['flat'] &&
    e.attrs.size === 1 &&
    rest.length === 0 &&
    c?.kind === 'text'
  );
}

/**
 * The invariant violations of a rendered tree (empty when it passes): the tag and attribute
 * allowlist, anchors and images by the independent checker, the span forms, the DOM depth and
 * well-formed text.
 */
export function checkInvariants(
  root: TElement,
  policy: Policy,
  opts?: { readonly headingOffset?: number },
): string[] {
  const out: string[] = [];
  const headings =
    opts?.headingOffset === 0 ? ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] : ['h4', 'h5', 'h6'];
  const tags = new Set([...BASE_TAGS, ...headings]);
  const stack: { n: TNode; parent: TElement | null; depth: number }[] = root.children.map((n) => ({
    n,
    parent: null,
    depth: 1,
  }));
  for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
    const { n, parent, depth } = f;
    if (n.kind === 'text') {
      if (LONE_SURROGATE.test(n.value))
        out.push(`text not well-formed: ${JSON.stringify(n.value)}`);
      continue;
    }
    if (depth > MAX_DOM_DEPTH) out.push(`depth ${String(depth)} > ${String(MAX_DOM_DEPTH)}`);
    if (!tags.has(n.tag)) out.push(`tag <${n.tag}>`);
    for (const [name, value] of n.attrs) {
      if (!ATTRS.has(name) || /^on/i.test(name)) out.push(`attribute ${name} on <${n.tag}>`);
      if (LONE_SURROGATE.test(value)) out.push(`attribute ${name} not well-formed`);
    }
    if (n.tag === 'a') {
      const href = n.attrs.get('href') ?? '';
      const k = checkHref(href);
      if (n.attrs.get('target') !== '_blank') out.push(`<a> without target=_blank`);
      const rel = (n.attrs.get('rel') ?? '').split(/\s+/).sort().join(' ');
      if (rel !== 'nofollow noopener noreferrer') out.push(`<a> rel ${rel}`);
      if (k === 'bad') out.push(`<a href> bad: ${JSON.stringify(href)}`);
      if (policy === 'ai' && k !== 'local') out.push(`ai <a href> ${k}: ${JSON.stringify(href)}`);
    }
    if (n.tag === 'img') {
      const src = n.attrs.get('src') ?? '';
      if (policy !== 'board') out.push(`<img> under ${policy}`);
      if (!checkImgSrc(src)) out.push(`<img src> bad: ${JSON.stringify(src)}`);
    }
    if (n.tag === 'span' && !isGlyph(n, parent) && !isHiddenText(n, parent) && !isFlat(n)) {
      out.push('a span that is not the glyph, the hidden text or a flat span');
    }
    for (const c of n.children) stack.push({ n: c, parent: n, depth: depth + 1 });
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The corpus shape of a rendered tree (the format `scripts/gen-xss-corpus.ts` writes): anchors as
 * `<a:‹checkHref›>…↗</a>` (the glyph and hidden text become `↗`), images as
 * `<img:ok|bad alt="…">`, flat spans as `<flat>…</flat>`, `ol` with its `start`, `code` with its
 * `data-lang`; text escaped.
 */
export function shapeOf(root: TElement): string {
  let s = '';
  type Item = { n: TNode; parent: TElement | null } | string;
  const stack: Item[] = [...root.children].reverse().map((n) => ({ n, parent: root }));
  for (let it = stack.pop(); it !== undefined; it = stack.pop()) {
    if (typeof it === 'string') {
      s += it;
      continue;
    }
    const { n, parent } = it;
    if (n.kind === 'text') {
      s += esc(n.value);
      continue;
    }
    if (isGlyph(n, parent)) {
      s += '↗';
      continue;
    }
    if (isHiddenText(n, parent)) continue;
    let open = `<${n.tag}>`;
    let close = `</${n.tag}>`;
    if (n.tag === 'a') open = `<a:${checkHref(n.attrs.get('href') ?? '')}>`;
    if (n.tag === 'img') {
      s += `<img:${checkImgSrc(n.attrs.get('src') ?? '') ? 'ok' : 'bad'} alt="${esc(n.attrs.get('alt') ?? '').replace(/"/g, '&quot;')}">`;
      continue;
    }
    if (n.tag === 'hr' || n.tag === 'br') {
      s += open;
      continue;
    }
    if (n.tag === 'span' && isFlat(n)) {
      open = '<flat>';
      close = '</flat>';
    }
    const start = n.attrs.get('start');
    if (n.tag === 'ol' && start !== undefined) open = `<ol start=${start}>`;
    const lang = n.attrs.get('data-lang');
    if (n.tag === 'code' && lang !== undefined) open = `<code lang=${lang}>`;
    s += open;
    stack.push(close);
    for (let i = n.children.length - 1; i >= 0; i--) {
      const c = n.children[i];
      if (c !== undefined) stack.push({ n: c, parent: n });
    }
  }
  return s;
}
