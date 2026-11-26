/**
 * The one Markdown renderer (T24-004; plan #198 Part 2b §3.1, §4): the `commonmark` tree, walked
 * post-order with an explicit stack, into the T24 §4.2 React elements. No HTML string, no Trusted
 * Types policy, no network or DOM call; React escapes every text and attribute.
 *
 * - Links and images are classified (`classifyUrl`, T24-005) after interpolation (T24-008); a kept
 *   link opens in a new tab with a glyph and a hidden "(opens in a new tab)". Under `ai` only
 *   `local` links are anchors, and external and mailto links are text with their host or address
 *   (T24-018, until the T18 §4.10 interstitial).
 * - Images: `board` + `local` → `<img>` (a decoded `/api` or `/auth` path counts as external);
 *   `board` + `external` → a new-tab link (alt text inside a kept link); otherwise alt text.
 * - HTML never renders (T24-006): one `html` or `iframe` removal per `html_block` and per leaf
 *   block's inline HTML.
 * - Depth: each node costs the elements it creates (§4.3). A block whose deepest element would
 *   pass `MAX_DEPTH − 1` shows its whole source lines in one `pre-wrap` text node instead, with one
 *   `depth` removal, and its children are not visited. The DOM depth stays ≤ `MAX_DEPTH`.
 * - Removals are `{kind, line}` only (T24-007), in document order.
 *
 * `renderMarkdown` is pure, never throws and is memoised (LRU 32).
 */
import { Parser, type Node } from 'commonmark';
import { createElement, Fragment, type ReactElement, type ReactNode } from 'react';
import type { CodeLanguage } from '../../api/types';
import { VARIABLE_REF } from '../../boards/variableRefs';
import { t } from '../../i18n/t';
import { Icon } from '../../kit/Icon';
import { findIframes } from './findIframes';
import styles from './markdown.module.css';
import { classifyUrl, toWellFormed, type UrlClass } from './url';

export type RenderPolicy = 'board' | 'ai';
export type RemovalKind = 'html' | 'iframe' | 'linkScheme' | 'image' | 'unresolved' | 'depth';
/** A removal names its kind and the start line of the nearest block, never content (T24-007). */
export interface Removal {
  readonly kind: RemovalKind;
  readonly line: number;
}
export interface MarkdownEnv {
  readonly vars: ReadonlyMap<string, string>;
  readonly entity: string | null;
}
export interface MarkdownOpts {
  readonly policy: RenderPolicy;
  readonly appOrigin: string;
  /** Added to a heading's level (default 3: `#` → `<h4>`). */
  readonly headingOffset?: number;
}
export interface MarkdownResult {
  readonly node: ReactNode;
  readonly removals: readonly Removal[];
}

/** The DOM depth below the root: elements reach `MAX_DEPTH − 1`, a flat span `MAX_DEPTH`. */
export const MAX_DEPTH = 32;

const DEST_REF = /\$(?:%7[Bb]([A-Za-z_][A-Za-z0-9_]*)%7[Dd]|([A-Za-z_][A-Za-z0-9_]*))/g;
const DEST_ENTITY = /%7[Bb]%7[Bb]entity%7[Dd]%7[Dd]/g;
const TEXT_SUBST = new RegExp(`\\{\\{entity\\}\\}|${VARIABLE_REF.source}`, 'g');
const DEST_SUBST = new RegExp(`${DEST_ENTITY.source}|${DEST_REF.source}`, 'g');
const LINE = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g;
const LANG = /^[a-z0-9-]{1,20}$/;
const IFRAME_NAME = /iframe/i;
const REL = 'noopener noreferrer nofollow';
const MEMO_SIZE = 32;
const LOG_PANELS = 512;
const BLOCKS: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'block_quote',
  'list',
  'item',
  'thematic_break',
  'code_block',
  'html_block',
]);

/**
 * The source lines `start..end` (1-based, clamped to the lines of `src`; `end < start` → `start`),
 * verbatim, each with its own terminator (`\r\n`, `\n` or `\r`). Empty `src` → `''`. O(lines).
 */
export function sourceLines(src: string, start: number, end: number): string {
  const lines = src.match(LINE) ?? [];
  const n = lines.length;
  if (n === 0) return '';
  const s = Math.min(Math.max(start, 1), n);
  const e = Math.max(Math.min(Math.max(end, 1), n), s);
  return lines.slice(s - 1, e).join('');
}

const UTF8 = new TextEncoder();
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** One round of byte-level percent-decoding: each `%XX` becomes its byte. */
function decodeBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0;
    const hex = b === 0x25 ? String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out[n++] = parseInt(hex, 16);
      i += 2;
    } else {
      out[n++] = b;
    }
  }
  return out.slice(0, n);
}

/** `bytes` starts with `prefix` (ASCII, compared case-insensitively). */
function bytePrefix(bytes: Uint8Array, prefix: string): boolean {
  for (let i = 0; i < prefix.length; i++) {
    const b = bytes[i];
    if (b === undefined) return false;
    const lower = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
    if (lower !== prefix.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * True if a local href's path is a server route (`/api`, `/auth` or under them), so that an image
 * there is not loaded (T24-018). The path is percent-decoded at the byte level, as the server
 * routes on it, for up to three rounds; a path that still changes after three rounds, or whose
 * bytes are not valid UTF-8, counts as a server route too.
 */
function serverRoute(href: string): boolean {
  let bytes: Uint8Array = UTF8.encode(href.split(/[?#]/)[0] ?? '');
  for (let round = 0; round < 3; round++) {
    const next = decodeBytes(bytes);
    if (next.length === bytes.length) break;
    bytes = next;
  }
  if (decodeBytes(bytes).length !== bytes.length) return true;
  try {
    STRICT_UTF8.decode(bytes);
  } catch {
    return true;
  }
  const exact = (p: string): boolean => bytes.length === p.length && bytePrefix(bytes, p);
  return (
    exact('/api') || exact('/auth') || bytePrefix(bytes, '/api/') || bytePrefix(bytes, '/auth/')
  );
}

type Out = string | ReactElement;
type ImageUse = 'img' | 'link' | 'text';

interface Ctx {
  /** Elements above the node's output. */
  readonly depth: number;
  readonly inAlt: boolean;
  readonly inKeptLink: boolean;
}

type Finish =
  | {
      readonly kind: 'element';
      readonly tag: string;
      readonly props: Readonly<Record<string, string>>;
      readonly newTab: boolean;
    }
  | { readonly kind: 'unwrap'; readonly suffix: string }
  | { readonly kind: 'text-only' }
  | { readonly kind: 'alt'; readonly use: ImageUse; readonly url: UrlClass };

interface Frame {
  readonly finish: Finish;
  readonly out: Out[];
  /** The context of the node's children. */
  readonly ctx: Ctx;
  next: Node | null;
}

interface Dest {
  readonly url: UrlClass;
  readonly unresolved: number;
}

/**
 * The removal kind of dropped HTML (T24-006). An iframe start tag needs the letters `iframe` (any
 * case) in the source, so the parse is skipped without them; the result is `findIframes`'s.
 */
function htmlKind(html: string): 'html' | 'iframe' {
  return IFRAME_NAME.test(html) && findIframes(html).length > 0 ? 'iframe' : 'html';
}

/** Appends to an output list, merging adjacent strings into one text node. */
function append(out: Out[], item: Out): void {
  const last = out.length - 1;
  const prev = out[last];
  if (typeof item === 'string' && typeof prev === 'string') out[last] = prev + item;
  else if (item !== '') out.push(item);
}

function textOf(out: readonly Out[]): string {
  return out.filter((o): o is string => typeof o === 'string').join('');
}

/** One render: the walk's state. */
class Walk {
  readonly removals: Removal[] = [];
  private readonly dests = new Map<Node, Dest>();
  private key = 0;
  private line = 1;
  private leafHtml: 'html' | 'iframe' | null = null;
  private stackSize = -1;

  constructor(
    private readonly src: string,
    private readonly vars: ReadonlyMap<string, string>,
    private readonly entity: string | null,
    private readonly opts: MarkdownOpts,
  ) {}

  /** The size of the explicit stack when the walk returned. */
  get stackAfter(): number {
    return this.stackSize;
  }

  private rm(kind: RemovalKind, line = this.line): void {
    this.removals.push({ kind, line });
  }

  private k(): string {
    return String(this.key++);
  }

  private interpText(s: string): string {
    return s.replace(TEXT_SUBST, (whole: string, braced?: string, bare?: string) => {
      const name = braced ?? bare;
      if (name === undefined) {
        if (this.entity !== null) return this.entity;
        this.rm('unresolved');
        return whole;
      }
      if (name.startsWith('__')) return whole;
      const v = this.vars.get(name);
      if (v === undefined) {
        this.rm('unresolved');
        return whole;
      }
      return v;
    });
  }

  /** The node's destination interpolated (unresolved references counted), then classified. */
  private dest(n: Node): Dest {
    const hit = this.dests.get(n);
    if (hit !== undefined) return hit;
    let unresolved = 0;
    const raw = (n.destination ?? '').replace(
      DEST_SUBST,
      (whole: string, braced?: string, bare?: string) => {
        const name = braced ?? bare;
        if (name?.startsWith('__') === true) return whole;
        const v = name === undefined ? this.entity : this.vars.get(name);
        if (v === undefined || v === null) {
          unresolved++;
          return whole;
        }
        return encodeURIComponent(v);
      },
    );
    const d: Dest = { url: classifyUrl(raw, this.opts.appOrigin), unresolved };
    this.dests.set(n, d);
    return d;
  }

  private keptLink(url: UrlClass): boolean {
    return this.opts.policy === 'board' ? url.kind !== 'rejected' : url.kind === 'local';
  }

  private imageUse(url: UrlClass, inKeptLink: boolean): ImageUse {
    if (this.opts.policy !== 'board') return 'text';
    if (url.kind === 'local' && !serverRoute(url.href)) return 'img';
    if (url.kind === 'local' || url.kind === 'external') return inKeptLink ? 'text' : 'link';
    return 'text';
  }

  /** An inline node's cost (§4.3) and its children's link and alt context. */
  private inlineCost(n: Node, kept: boolean): { cost: number; kept: boolean; alt: boolean } {
    switch (n.type) {
      case 'emph':
      case 'strong':
      case 'code':
      case 'linebreak':
        return { cost: 1, kept, alt: false };
      case 'link':
        return this.keptLink(this.dest(n).url)
          ? { cost: 2, kept: true, alt: false }
          : { cost: 0, kept, alt: false };
      case 'image': {
        const use = this.imageUse(this.dest(n).url, kept);
        return { cost: use === 'img' ? 1 : use === 'link' ? 2 : 0, kept, alt: true };
      }
      default:
        return { cost: 0, kept, alt: false };
    }
  }

  /**
   * The pre-scan of a leaf block (§4.3): the deepest element chain its inlines create, by an
   * iterative post-order over the inline subtree, and its inline HTML joined (T24-006).
   */
  private prescan(leaf: Node): { inner: number; html: string } {
    interface S {
      readonly cost: number;
      readonly kept: boolean;
      readonly alt: boolean;
      max: number;
      next: Node | null;
    }
    let html = '';
    const stack: S[] = [{ cost: 0, kept: false, alt: false, max: 0, next: leaf.firstChild }];
    for (;;) {
      const top = stack[stack.length - 1];
      if (top === undefined) return { inner: 0, html };
      const c = top.next;
      if (c !== null) {
        top.next = c.next;
        if (c.type === 'html_inline') html += c.literal ?? '';
        const x = top.alt ? { cost: 0, kept: top.kept, alt: true } : this.inlineCost(c, top.kept);
        if (c.firstChild !== null) stack.push({ ...x, max: 0, next: c.firstChild });
        else top.max = Math.max(top.max, x.cost);
        continue;
      }
      stack.pop();
      const chain = top.cost + top.max;
      const parent = stack[stack.length - 1];
      if (parent === undefined) return { inner: chain, html };
      parent.max = Math.max(parent.max, chain);
    }
  }

  private element(tag: string, props: Readonly<Record<string, string>>, children?: Out[]): Out {
    return createElement(tag, { ...props, key: this.k() }, children);
  }

  private newTabChildren(out: readonly Out[]): Out[] {
    return [
      ...out,
      createElement(Icon, { name: 'square-arrow-out-up-right', key: this.k() }),
      createElement('span', { className: styles['srOnly'], key: this.k() }, t('markdown.newTab')),
    ];
  }

  private tight(n: Node): boolean {
    return (
      n.type === 'paragraph' && n.parent?.type === 'item' && n.parent.parent?.listTight === true
    );
  }

  private push(stack: Frame[], f: Frame, finish: Finish, n: Node, ctx: Partial<Ctx>): void {
    stack.push({ finish, out: [], ctx: { ...f.ctx, ...ctx }, next: n.firstChild });
  }

  private unresolved(d: Dest): void {
    for (let i = 0; i < d.unresolved; i++) this.rm('unresolved');
  }

  private htmlOnce(): void {
    if (this.leafHtml === null) return;
    this.rm(this.leafHtml);
    this.leafHtml = null;
  }

  /** Enters `n`, a child of `f`: a leaf or a flat block appends to `f.out`; a container pushes. */
  private enter(stack: Frame[], f: Frame, n: Node): void {
    if (n.type === 'text') {
      // A run of text siblings is interpolated as one string.
      let s = n.literal ?? '';
      let next = n.next;
      while (next !== null && next.type === 'text') {
        s += next.literal ?? '';
        next = next.next;
      }
      f.next = next;
      append(f.out, this.interpText(s));
      return;
    }
    if (f.ctx.inAlt) this.enterAlt(stack, f, n);
    else if (BLOCKS.has(n.type)) this.enterBlock(stack, f, n);
    else this.enterInline(stack, f, n);
  }

  private enterInline(stack: Frame[], f: Frame, n: Node): void {
    const depth = f.ctx.depth;
    switch (n.type) {
      case 'softbreak':
        append(f.out, ' ');
        return;
      case 'linebreak':
        append(f.out, this.element('br', {}));
        return;
      case 'code':
        append(f.out, this.element('code', {}, [n.literal ?? '']));
        return;
      case 'emph':
      case 'strong': {
        const tag = n.type === 'emph' ? 'em' : 'strong';
        this.push(stack, f, { kind: 'element', tag, props: {}, newTab: false }, n, {
          depth: depth + 1,
        });
        return;
      }
      case 'html_inline':
        this.htmlOnce();
        return;
      case 'link':
        this.enterLink(stack, f, n);
        return;
      case 'image': {
        const d = this.dest(n);
        this.unresolved(d);
        const use = this.imageUse(d.url, f.ctx.inKeptLink);
        if (use !== 'img') this.rm('image');
        const cost = use === 'img' ? 1 : use === 'link' ? 2 : 0;
        this.push(stack, f, { kind: 'alt', use, url: d.url }, n, {
          depth: depth + cost,
          inAlt: true,
        });
        return;
      }
      default:
        this.rm('html');
    }
  }

  private enterLink(stack: Frame[], f: Frame, n: Node): void {
    const d = this.dest(n);
    this.unresolved(d);
    const url = d.url;
    if (url.kind !== 'rejected' && this.keptLink(url)) {
      const props = { href: url.href, target: '_blank', rel: REL };
      this.push(stack, f, { kind: 'element', tag: 'a', props, newTab: true }, n, {
        depth: f.ctx.depth + 2,
        inKeptLink: true,
      });
      return;
    }
    // `ai`: an external or mailto link is its text plus the host or address, with no removal.
    if (url.kind === 'external') {
      this.push(stack, f, { kind: 'unwrap', suffix: ` (${url.host})` }, n, {});
      return;
    }
    if (url.kind === 'mailto') {
      const address = url.href.slice('mailto:'.length).split('?')[0] ?? '';
      this.push(stack, f, { kind: 'unwrap', suffix: ` (${address})` }, n, {});
      return;
    }
    this.rm('linkScheme');
    this.push(stack, f, { kind: 'unwrap', suffix: '' }, n, {});
  }

  /** `text-only` (§4.3 kind 1): inside an image's alt only text survives. */
  private enterAlt(stack: Frame[], f: Frame, n: Node): void {
    switch (n.type) {
      case 'code':
        append(f.out, n.literal ?? '');
        return;
      case 'softbreak':
      case 'linebreak':
        append(f.out, ' ');
        return;
      case 'html_inline':
        this.htmlOnce();
        return;
      case 'image':
        this.rm('image');
        this.push(stack, f, { kind: 'text-only' }, n, {});
        return;
      default:
        this.push(stack, f, { kind: 'text-only' }, n, {});
    }
  }

  private enterBlock(stack: Frame[], f: Frame, n: Node): void {
    const line = n.sourcepos[0][0];
    if (n.type === 'html_block') {
      this.rm(htmlKind(n.literal ?? ''), line);
      return;
    }
    const hasInlines = n.type === 'paragraph' || n.type === 'heading';
    const scan = hasInlines ? this.prescan(n) : { inner: 0, html: '' };
    const cost = this.tight(n) ? 0 : n.type === 'code_block' ? 2 : 1;
    if (f.ctx.depth + cost + scan.inner > MAX_DEPTH - 1) {
      this.rm('depth', line);
      const text = sourceLines(this.src, line, n.sourcepos[1][0]);
      append(f.out, createElement('span', { className: styles['flat'], key: this.k() }, text));
      return;
    }
    if (hasInlines) {
      this.line = line;
      this.leafHtml = scan.html === '' ? null : htmlKind(scan.html);
    }
    const depth = f.ctx.depth + cost;
    const el = (tag: string, props: Readonly<Record<string, string>> = {}): void => {
      this.push(stack, f, { kind: 'element', tag, props, newTab: false }, n, { depth });
    };
    switch (n.type) {
      case 'paragraph':
        if (cost === 0) this.push(stack, f, { kind: 'unwrap', suffix: '' }, n, {});
        else el('p');
        return;
      case 'heading':
        el(`h${String(Math.min(Math.max(n.level + (this.opts.headingOffset ?? 3), 1), 6))}`);
        return;
      case 'block_quote':
        el('blockquote');
        return;
      case 'item':
        el('li');
        return;
      case 'list': {
        if (n.listType !== 'ordered') {
          el('ul');
          return;
        }
        const start = Math.min(n.listStart, 999_999);
        el('ol', start === 1 ? {} : { start: String(start) });
        return;
      }
      case 'thematic_break':
        append(f.out, this.element('hr', {}));
        return;
      default: {
        // code_block: the literal, never interpolated.
        const word = (n.info ?? '').split(/[ \t]/)[0] ?? '';
        const props: Readonly<Record<string, string>> = LANG.test(word)
          ? { 'data-lang': word }
          : {};
        const code = createElement('code', props, n.literal ?? '');
        append(f.out, createElement('pre', { key: this.k() }, code));
      }
    }
  }

  /** The output a finished frame gives its parent. */
  private result(f: Frame): readonly Out[] {
    const x = f.finish;
    switch (x.kind) {
      case 'element':
        return [this.element(x.tag, x.props, x.newTab ? this.newTabChildren(f.out) : f.out)];
      case 'unwrap':
        return x.suffix === '' ? f.out : [...f.out, x.suffix];
      case 'text-only':
        return [textOf(f.out)];
      case 'alt': {
        const alt = textOf(f.out);
        const url = x.url;
        if (url.kind === 'rejected' || url.kind === 'mailto' || x.use === 'text') return [alt];
        if (x.use === 'img') return [this.element('img', { src: url.href, alt, loading: 'lazy' })];
        const props = { href: url.href, target: '_blank', rel: REL };
        return [this.element('a', props, this.newTabChildren([alt === '' ? url.host : alt]))];
      }
    }
  }

  /** The walk (§4.3): post-order with an explicit stack; the root is returned, never appended. */
  run(doc: Node): ReactNode {
    const stack: Frame[] = [
      {
        finish: { kind: 'unwrap', suffix: '' },
        out: [],
        ctx: { depth: 0, inAlt: false, inKeptLink: false },
        next: doc.firstChild,
      },
    ];
    for (;;) {
      const f = stack[stack.length - 1];
      if (f === undefined) return null;
      const child = f.next;
      if (child !== null) {
        f.next = child.next;
        this.enter(stack, f, child);
        continue;
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent === undefined) {
        this.stackSize = stack.length;
        return createElement(Fragment, null, f.out);
      }
      for (const o of this.result(f)) append(parent.out, o);
    }
  }
}

const memo = new Map<string, MarkdownResult>();
const stats = { hits: 0, misses: 0, stackAfterWalk: -1 };

/** Renders `src` (T24 §4.2). Pure; never throws; memoised (LRU 32). */
export function renderMarkdown(src: string, env: MarkdownEnv, opts: MarkdownOpts): MarkdownResult {
  const key = JSON.stringify([
    src,
    env.entity,
    opts.policy,
    opts.appOrigin,
    opts.headingOffset ?? 3,
    [...env.vars].sort(),
  ]);
  const hit = memo.get(key);
  if (hit !== undefined) {
    stats.hits++;
    memo.delete(key);
    memo.set(key, hit);
    return hit;
  }
  stats.misses++;
  const text = toWellFormed(src);
  const vars = new Map<string, string>();
  for (const [k, v] of env.vars) vars.set(k, toWellFormed(v));
  const entity = env.entity === null ? null : toWellFormed(env.entity);
  const walk = new Walk(text, vars, entity, opts);
  const node = walk.run(new Parser().parse(text));
  stats.stackAfterWalk = walk.stackAfter;
  const result: MarkdownResult = { node, removals: walk.removals };
  memo.set(key, result);
  if (memo.size > MEMO_SIZE) {
    const oldest = memo.keys().next();
    if (oldest.done !== true) memo.delete(oldest.value);
  }
  return result;
}

/** A code-mode body: the source verbatim, never parsed or interpolated. */
export function renderCode(src: string, language: CodeLanguage): ReactNode {
  return createElement('pre', null, createElement('code', { 'data-lang': language }, src));
}

/**
 * A 64-bit digest (two 32-bit multiply-xor lanes, as hex) of a serialised removal list: the log
 * keeps this, not the list, so each remembered panel costs a fixed 16 characters.
 */
function digest(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
}

/** Panel id → the digest of its last result; at most `LOG_PANELS`, the oldest evicted first. */
const logged = new Map<string, string>();

/**
 * One `console.debug({panelId, removals})` per distinct non-empty result of a panel (T24-007). The
 * last result's digest is kept for at most 512 panels; once a panel is evicted, its unchanged
 * result is logged once more.
 */
export function logRemovals(panelId: string, removals: readonly Removal[]): void {
  const key = digest(JSON.stringify(removals));
  if (logged.get(panelId) === key) return;
  logged.delete(panelId);
  logged.set(panelId, key);
  if (logged.size > LOG_PANELS) {
    const oldest = logged.keys().next();
    if (oldest.done !== true) logged.delete(oldest.value);
  }
  if (removals.length > 0) console.debug({ panelId, removals });
}

/** The editor's line for one removal (T24-007): its kind and line only. */
export function removalMessage(r: Removal): string {
  return t(`markdown.removal.${r.kind}`, { line: r.line });
}

/** Test hook: memo hits and misses, and the explicit stack's size after the last walk. */
export function memoStats(): {
  readonly hits: number;
  readonly misses: number;
  readonly stackAfterWalk: number;
} {
  return { ...stats };
}
