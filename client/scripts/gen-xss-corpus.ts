/**
 * Writes the XSS corpus `src/security/sanitise/__fixtures__/xss-corpus.json` (plan #198 Part 2b
 * §5.1): every payload × template case of `xssCorpus.ts`, parsed with the pinned commonmark, with
 * the expected output per policy. The expectation is derived here, from the parse tree, with the
 * independent checker (`urlCheck.ts`: `checkHref`, `checkImgSrc`), never with `classifyUrl` or the
 * renderer: a node's type, destination and context (`inAlt`, `inKeptLink`, `flat` by the §4.3
 * costs) and the `findIframes` hits decide it. `unit:markdown-xss-corpus` compares each rendered
 * DOM's shape (`testInvariants.ts` `shapeOf`) and removals with it.
 *
 * `npm run gen:xss-corpus` writes the file; `--check` compares it with the committed one and exits 1
 * when it is stale (`unit:xss-corpus-current` runs the same check).
 *
 * `findIframes` is a client module with extensionless imports and the `parse5-sax-parser/feedback`
 * alias: in Node it is loaded through the hook below, and Vitest resolves both itself.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Parser, type Node } from 'commonmark';
import { corpusCases, type CorpusCase } from '../src/security/sanitise/xssCorpus.ts';
import { checkHref, checkImgSrc, hrefHost } from '../src/security/sanitise/urlCheck.ts';

export const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
export const CORPUS_FILE = join(
  CLIENT_ROOT,
  'src',
  'security',
  'sanitise',
  '__fixtures__',
  'xss-corpus.json',
);
/** The T24 §10 test origin. */
export const ORIGIN = 'https://dash.test';
const APP_HOST = 'dash.test';
const MAX_DEPTH = 32;

export type Policy = 'board' | 'ai';
export type Removal = readonly [kind: string, line: number];
export interface Expectation {
  readonly dom: string;
  readonly removals: readonly Removal[];
}
export interface CorpusEntry extends CorpusCase {
  /** The parse: `type@line` per block, link and image destinations, `findIframes` hits. */
  readonly nodes: readonly string[];
  readonly expect: Readonly<Record<Policy, Expectation>>;
}

type FindIframes = (html: string) => readonly unknown[];

/** Node: the alias and the client's extensionless relative imports. */
function registerCorpusHooks(): void {
  const feedback = pathToFileURL(
    join(CLIENT_ROOT, 'node_modules/parse5-sax-parser/dist/parser-feedback-simulator.js'),
  ).href;
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'parse5-sax-parser/feedback') return next(feedback, context);
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        try {
          return next(`${specifier}.ts`, context);
        } catch {
          return next(specifier, context);
        }
      }
      return next(specifier, context);
    },
  });
}

async function loadFindIframes(): Promise<FindIframes> {
  // A non-literal specifier: the module's types belong to the app project, not this one.
  const path = '../src/security/sanitise/findIframes.ts';
  const m = (await import(path)) as { findIframes: FindIframes };
  return m.findIframes;
}

function wellFormed(s: string): string {
  return (s as string & { toWellFormed(): string }).toWellFormed();
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The source lines start..end (1-based, clamped), each with its own terminator. */
function lineRange(src: string, start: number, end: number): string {
  const lines = src.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g) ?? [];
  const n = lines.length;
  if (n === 0) return '';
  const s = Math.min(Math.max(start, 1), n);
  const e = Math.max(Math.min(Math.max(end, 1), n), s);
  return lines.slice(s - 1, e).join('');
}

const TEXT_REF = /\{\{entity\}\}|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const DEST_REF =
  /%7[Bb]%7[Bb]entity%7[Dd]%7[Dd]|\$(?:%7[Bb]([A-Za-z_][A-Za-z0-9_]*)%7[Dd]|([A-Za-z_][A-Za-z0-9_]*))/g;

interface Ctx {
  readonly depth: number;
  readonly inKept: boolean;
}

/** The expected output of one case under one policy. */
export function expectFor(c: CorpusCase, policy: Policy, findIframes: FindIframes): Expectation {
  const src = wellFormed(c.src);
  const vars = new Map(c.vars.map(([k, v]) => [k, wellFormed(v)] as const));
  const entity = c.entity === null ? null : wellFormed(c.entity);
  const removals: Removal[] = [];
  const rm = (kind: string, line: number): void => {
    removals.push([kind, line]);
  };
  let leaf: { kind: string | null; done: boolean } = { kind: null, done: true };

  const resolve = (whole: string, name: string | undefined): string | null => {
    if (whole.endsWith('entity}}') || /entity%7[Dd]%7[Dd]$/.test(whole)) return entity;
    if (name === undefined || name.startsWith('__')) return whole;
    return vars.get(name) ?? null;
  };
  const interpText = (s: string, line: number): string =>
    s.replace(TEXT_REF, (whole: string, a?: string, b?: string) => {
      const v = resolve(whole, a ?? b);
      if (v === null) rm('unresolved', line);
      return v ?? whole;
    });
  const interpDest = (s: string, line: number | null): string =>
    s.replace(DEST_REF, (whole: string, a?: string, b?: string) => {
      const name = a ?? b;
      if (name?.startsWith('__') === true) return whole;
      const v = resolve(whole, name);
      if (v === null && line !== null) rm('unresolved', line);
      return v === null ? whole : encodeURIComponent(v);
    });
  const kept = (k: string): boolean => (policy === 'board' ? k !== 'bad' : k === 'local');
  const htmlOnce = (line: number): void => {
    if (leaf.done || leaf.kind === null) return;
    leaf.done = true;
    rm(leaf.kind, line);
  };

  /** The deepest element chain an inline subtree creates (§4.3 costs, independent checker). */
  const chain = (n: Node, inKept: boolean): number => {
    const kidsMax = (k: boolean): number => {
      let m = 0;
      for (let c = n.firstChild; c !== null; c = c.next) m = Math.max(m, chain(c, k));
      return m;
    };
    switch (n.type) {
      case 'emph':
      case 'strong':
        return 1 + kidsMax(inKept);
      case 'code':
      case 'linebreak':
        return 1;
      case 'link': {
        const k = checkHref(interpDest(n.destination ?? '', null));
        return kept(k) ? 2 + kidsMax(true) : kidsMax(inKept);
      }
      case 'image': {
        const d = interpDest(n.destination ?? '', null);
        const k = checkHref(d);
        if (policy === 'board' && k === 'local' && checkImgSrc(d)) return 1;
        if (policy === 'board' && (k === 'external' || k === 'local') && !inKept) return 2;
        return 0;
      }
      default:
        return 0;
    }
  };
  const inner = (n: Node): number => {
    let m = 0;
    for (let c = n.firstChild; c !== null; c = c.next) m = Math.max(m, chain(c, false));
    return m;
  };
  const htmlLiterals = (n: Node): string => {
    let s = '';
    const w = n.walker();
    for (let e = w.next(); e !== null; e = w.next()) {
      if (e.entering && e.node.type === 'html_inline') s += e.node.literal ?? '';
    }
    return s;
  };

  /** The text of an image's children (§4.3 `text-only`). */
  const altText = (n: Node, line: number): string => {
    let s = '';
    let c = n.firstChild;
    while (c !== null) {
      if (c.type === 'text') {
        let t = '';
        while (c !== null && c.type === 'text') {
          t += c.literal ?? '';
          c = c.next;
        }
        s += interpText(t, line);
        continue;
      }
      if (c.type === 'code') s += c.literal ?? '';
      else if (c.type === 'softbreak' || c.type === 'linebreak') s += ' ';
      else if (c.type === 'html_inline') htmlOnce(line);
      else if (c.type === 'image') {
        rm('image', line);
        s += altText(c, line);
      } else s += altText(c, line);
      c = c.next;
    }
    return s;
  };

  const kids = (n: Node, ctx: Ctx, line: number): string => {
    let s = '';
    let c = n.firstChild;
    while (c !== null) {
      if (c.type === 'text') {
        let t = '';
        while (c !== null && c.type === 'text') {
          t += c.literal ?? '';
          c = c.next;
        }
        s += esc(interpText(t, line));
        continue;
      }
      s += inline(c, ctx, line);
      c = c.next;
    }
    return s;
  };

  const inline = (n: Node, ctx: Ctx, line: number): string => {
    switch (n.type) {
      case 'softbreak':
        return ' ';
      case 'linebreak':
        return '<br>';
      case 'code':
        return `<code>${esc(n.literal ?? '')}</code>`;
      case 'emph':
        return `<em>${kids(n, { ...ctx, depth: ctx.depth + 1 }, line)}</em>`;
      case 'strong':
        return `<strong>${kids(n, { ...ctx, depth: ctx.depth + 1 }, line)}</strong>`;
      case 'html_inline':
        htmlOnce(line);
        return '';
      case 'link': {
        const d = interpDest(n.destination ?? '', line);
        const k = checkHref(d);
        if (kept(k)) return `<a:${k}>${kids(n, { depth: ctx.depth + 2, inKept: true }, line)}↗</a>`;
        if (policy === 'ai' && (k === 'external' || k === 'mailto')) {
          const label = k === 'external' ? hrefHost(d) : (d.slice(7).split('?')[0] ?? '');
          return `${kids(n, ctx, line)}${esc(` (${label})`)}`;
        }
        rm('linkScheme', line);
        return kids(n, ctx, line);
      }
      case 'image': {
        const d = interpDest(n.destination ?? '', line);
        const k = checkHref(d);
        if (policy === 'board' && k === 'local' && checkImgSrc(d)) {
          return `<img:ok alt="${esc(altText(n, line)).replace(/"/g, '&quot;')}">`;
        }
        rm('image', line);
        const alt = altText(n, line);
        if (policy === 'board' && (k === 'external' || k === 'local') && !ctx.inKept) {
          const host = k === 'external' ? hrefHost(d) : APP_HOST;
          return `<a:${k}>${esc(alt === '' ? host : alt)}↗</a>`;
        }
        return esc(alt);
      }
      default:
        rm('html', line);
        return '';
    }
  };

  const tight = (n: Node): boolean =>
    n.type === 'paragraph' && n.parent?.type === 'item' && n.parent.parent?.listTight === true;

  const block = (n: Node, depth: number): string => {
    const line = n.sourcepos[0][0];
    if (n.type === 'html_block') {
      rm(findIframes(n.literal ?? '').length > 0 ? 'iframe' : 'html', line);
      return '';
    }
    const isLeaf = n.type === 'paragraph' || n.type === 'heading';
    const cost = tight(n) ? 0 : n.type === 'code_block' ? 2 : 1;
    if (depth + cost + (isLeaf ? inner(n) : 0) > MAX_DEPTH - 1) {
      rm('depth', line);
      return `<flat>${esc(lineRange(src, line, n.sourcepos[1][0]))}</flat>`;
    }
    const d = depth + cost;
    const blocks = (): string => {
      let s = '';
      for (let c = n.firstChild; c !== null; c = c.next) s += block(c, d);
      return s;
    };
    if (isLeaf) {
      const html = htmlLiterals(n);
      leaf = {
        kind: html === '' ? null : findIframes(html).length > 0 ? 'iframe' : 'html',
        done: false,
      };
    }
    switch (n.type) {
      case 'paragraph': {
        const body = kids(n, { depth: d, inKept: false }, line);
        return cost === 0 ? body : `<p>${body}</p>`;
      }
      case 'heading': {
        const h = `h${String(Math.min(n.level + 3, 6))}`;
        return `<${h}>${kids(n, { depth: d, inKept: false }, line)}</${h}>`;
      }
      case 'block_quote':
        return `<blockquote>${blocks()}</blockquote>`;
      case 'item':
        return `<li>${blocks()}</li>`;
      case 'list': {
        if (n.listType !== 'ordered') return `<ul>${blocks()}</ul>`;
        const start = Math.min(n.listStart, 999_999);
        return `${start === 1 ? '<ol>' : `<ol start=${String(start)}>`}${blocks()}</ol>`;
      }
      case 'thematic_break':
        return '<hr>';
      case 'code_block': {
        const word = (n.info ?? '').split(/[ \t]/)[0] ?? '';
        const lang = /^[a-z0-9-]{1,20}$/.test(word) ? ` lang=${word}` : '';
        return `<pre><code${lang}>${esc(n.literal ?? '')}</code></pre>`;
      }
      default:
        rm('html', line);
        return '';
    }
  };

  const doc = new Parser().parse(src);
  let dom = '';
  for (let c = doc.firstChild; c !== null; c = c.next) dom += block(c, 0);
  return { dom, removals };
}

const BLOCKS = new Set([
  'block_quote',
  'list',
  'item',
  'paragraph',
  'heading',
  'code_block',
  'html_block',
  'thematic_break',
]);

/** The parse record of a case: blocks with lines, destinations and iframe hits, runs collapsed. */
function nodesOf(c: CorpusCase, findIframes: FindIframes): string[] {
  const out: string[] = [];
  const w = new Parser().parse(wellFormed(c.src)).walker();
  for (let e = w.next(); e !== null; e = w.next()) {
    const n = e.node;
    if (!e.entering || n.type === 'document' || n.type === 'text') continue;
    let s = BLOCKS.has(n.type) ? `${n.type}@${String(n.sourcepos[0][0])}` : n.type;
    if (n.type === 'link' || n.type === 'image') s += ` ${n.destination ?? ''}`;
    if (n.type === 'html_block' || n.type === 'html_inline') {
      s += ` iframes=${String(findIframes(n.literal ?? '').length)}`;
    }
    const last = out[out.length - 1];
    const m = last === undefined ? null : /^(.*?)(?: ×(\d+))?$/.exec(last);
    if (m !== null && m[1] === s) out[out.length - 1] = `${s} ×${String(Number(m[2] ?? '1') + 1)}`;
    else out.push(s);
  }
  return out;
}

/** The corpus file's text. */
export async function corpusText(): Promise<string> {
  const findIframes = await loadFindIframes();
  const cases: CorpusEntry[] = corpusCases().map((c) => ({
    ...c,
    nodes: nodesOf(c, findIframes),
    expect: {
      board: expectFor(c, 'board', findIframes),
      ai: expectFor(c, 'ai', findIframes),
    },
  }));
  return `${JSON.stringify({ version: 1, origin: ORIGIN, cases }, null, 1)}\n`;
}

/** 0 when `committed` equals `fresh`, else 1 (with a message). */
export function check(committed: string, fresh: string): number {
  if (committed === fresh) return 0;
  console.error(
    'error[xss-corpus] src/security/sanitise/__fixtures__/xss-corpus.json is stale: run `npm run gen:xss-corpus`',
  );
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  registerCorpusHooks();
  const fresh = await corpusText();
  if (!argv.includes('--check')) {
    writeFileSync(CORPUS_FILE, fresh);
    return 0;
  }
  let committed = '';
  try {
    committed = readFileSync(CORPUS_FILE, 'utf8');
  } catch {
    committed = '';
  }
  return check(committed, fresh);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
