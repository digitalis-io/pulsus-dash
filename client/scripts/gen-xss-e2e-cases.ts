/**
 * Writes `e2e/fixtures/xss-e2e-cases.json` (plan #198 Part 3b §3): the browser run's list of the XSS
 * corpus, from `src/security/sanitise/__fixtures__/xss-corpus.json`, independently of the renderer
 * (it never imports `url.ts` or `markdown.tsx`). Per case:
 *
 * - `digest`: `caseDigest` (`e2e/xssCases.ts`) of the source, variables and entity.
 * - `skip`: `entity` when the case has an entity (a board has none, `{{entity}}` is `null`);
 *   `varNotUrlSafe` when a variable value fails `checkParamValue`, so a `var-` parameter cannot carry
 *   it; `nul` when the source holds U+0000, which the server refuses; else `null`.
 * - `images`: the case's source parsed with the pinned commonmark, keeping each image node that
 *   renders as `<img>` under `board`: not in alt text, not in a flat block (the Part 2b costs), and
 *   `checkImgSrc` true for its destination after interpolation (T24-008: the case's variables,
 *   `encodeURIComponent`). Each destination becomes the request path the browser sends, `new
 *   URL(dest, origin)`'s pathname and search; the paths are deduplicated, in document order.
 *
 * `npm run gen:xss-e2e-cases` writes the file; `--check` compares it with the committed one and
 * exits 1 with the differences (`compareCases`) when it is stale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { Parser, type Node } from 'commonmark';
import { checkHref, checkImgSrc } from '../src/security/sanitise/urlCheck.ts';
import type { CorpusCase } from '../src/security/sanitise/xssCorpus.ts';
import {
  caseDigest,
  compareCases,
  E2E_CASES_FILE,
  type E2eCase,
  type SkipReason,
} from '../e2e/xssCases.ts';
import { CORPUS_FILE, ORIGIN } from './gen-xss-corpus.ts';

const MAX_DEPTH = 32;

export type CheckParamValue = (value: string) => string | null;

/** Node: the client's extensionless relative imports (`boardParams` and what it imports). */
function registerClientHooks(): void {
  registerHooks({
    resolve(specifier, context, next) {
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

export async function loadCheckParamValue(): Promise<CheckParamValue> {
  // A non-literal specifier: the module's types belong to the app project, not this one.
  const path = '../src/state/boardParams.ts';
  const m = (await import(path)) as { checkParamValue: CheckParamValue };
  return m.checkParamValue;
}

function wellFormed(s: string): string {
  return (s as string & { toWellFormed(): string }).toWellFormed();
}

const DEST_REF =
  /%7[Bb]%7[Bb]entity%7[Dd]%7[Dd]|\$(?:%7[Bb]([A-Za-z_][A-Za-z0-9_]*)%7[Dd]|([A-Za-z_][A-Za-z0-9_]*))/g;

/** The image request paths of `c` under `board` (see the header). */
export function imagePaths(c: CorpusCase): string[] {
  const vars = new Map(c.vars.map(([k, v]) => [k, wellFormed(v)] as const));
  const entity = c.entity === null ? null : wellFormed(c.entity);
  const interp = (d: string): string =>
    d.replace(DEST_REF, (whole: string, a?: string, b?: string) => {
      if (whole.toLowerCase().endsWith('entity%7d%7d')) {
        return entity === null ? whole : encodeURIComponent(entity);
      }
      const name = a ?? b ?? '';
      if (name.startsWith('__')) return whole;
      const v = vars.get(name);
      return v === undefined ? whole : encodeURIComponent(v);
    });
  const isImg = (n: Node): boolean => {
    const d = interp(n.destination ?? '');
    return checkHref(d) === 'local' && checkImgSrc(d);
  };
  const kept = (n: Node): boolean => checkHref(interp(n.destination ?? '')) !== 'bad';

  /** The deepest element chain below an inline (the Part 2b costs, `board`). */
  const chain = (n: Node, inKept: boolean): number => {
    const kidsMax = (k: boolean): number => {
      let m = 0;
      for (let x = n.firstChild; x !== null; x = x.next) m = Math.max(m, chain(x, k));
      return m;
    };
    switch (n.type) {
      case 'emph':
      case 'strong':
        return 1 + kidsMax(inKept);
      case 'code':
      case 'linebreak':
        return 1;
      case 'link':
        return kept(n) ? 2 + kidsMax(true) : kidsMax(inKept);
      case 'image': {
        if (isImg(n)) return 1;
        const k = checkHref(interp(n.destination ?? ''));
        return (k === 'external' || k === 'local') && !inKept ? 2 : 0;
      }
      default:
        return 0;
    }
  };
  const inner = (n: Node): number => {
    let m = 0;
    for (let x = n.firstChild; x !== null; x = x.next) m = Math.max(m, chain(x, false));
    return m;
  };
  const tight = (n: Node): boolean =>
    n.type === 'paragraph' && n.parent?.type === 'item' && n.parent.parent?.listTight === true;

  const out: string[] = [];
  /** An inline subtree outside alt text: its `<img>` destinations, in document order. */
  const inlines = (n: Node): void => {
    for (let x = n.firstChild; x !== null; x = x.next) {
      if (x.type === 'image') {
        // Only text survives in alt text: a nested image never renders.
        if (isImg(x)) out.push(interp(x.destination ?? ''));
        continue;
      }
      inlines(x);
    }
  };
  const block = (n: Node, depth: number): void => {
    if (n.type === 'html_block') return;
    const leaf = n.type === 'paragraph' || n.type === 'heading';
    const cost = tight(n) ? 0 : n.type === 'code_block' ? 2 : 1;
    if (depth + cost + (leaf ? inner(n) : 0) > MAX_DEPTH - 1) return; // flat: source lines only
    if (leaf) {
      inlines(n);
      return;
    }
    for (let x = n.firstChild; x !== null; x = x.next) block(x, depth + cost);
  };
  const doc = new Parser().parse(wellFormed(c.src));
  for (let x = doc.firstChild; x !== null; x = x.next) block(x, 0);

  const paths: string[] = [];
  for (const d of out) {
    const u = new URL(d, ORIGIN);
    const p = u.pathname + u.search;
    if (!paths.includes(p)) paths.push(p);
  }
  return paths;
}

/** The skip reason of `c` (see the header). */
export function skipOf(c: CorpusCase, checkParamValue: CheckParamValue): SkipReason | null {
  if (c.entity !== null) return 'entity';
  if (c.vars.some(([, v]) => checkParamValue(v) !== null)) return 'varNotUrlSafe';
  if (c.src.includes('\u0000')) return 'nul';
  return null;
}

export function e2eCase(c: CorpusCase, checkParamValue: CheckParamValue): E2eCase {
  return {
    id: c.id,
    digest: caseDigest(c),
    skip: skipOf(c, checkParamValue),
    images: imagePaths(c),
  };
}

/** The corpus cases of the committed `xss-corpus.json`. */
export function corpusInput(file: string = CORPUS_FILE): CorpusCase[] {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { cases: CorpusCase[] };
  return doc.cases.map(({ id, group, src, vars, entity }) => ({ id, group, src, vars, entity }));
}

export async function generate(corpus: readonly CorpusCase[] = corpusInput()): Promise<E2eCase[]> {
  const checkParamValue = await loadCheckParamValue();
  return corpus.map((c) => e2eCase(c, checkParamValue));
}

export function casesText(cases: readonly E2eCase[]): string {
  return `${JSON.stringify({ version: 1, cases }, null, 1)}\n`;
}

/** 0 when `committed` equals `fresh`, else 1 (with the differences). */
export function check(committed: string, fresh: readonly E2eCase[]): number {
  if (committed === casesText(fresh)) return 0;
  let diff: string[];
  try {
    diff = compareCases(fresh, (JSON.parse(committed) as { cases: E2eCase[] }).cases);
  } catch {
    diff = ['the committed file is not JSON'];
  }
  console.error(
    `error[xss-e2e-cases] e2e/fixtures/xss-e2e-cases.json is stale: run \`npm run gen:xss-e2e-cases\`\n${diff.join('\n')}`,
  );
  return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
  registerClientHooks();
  const fresh = await generate();
  if (!argv.includes('--check')) {
    writeFileSync(E2E_CASES_FILE, casesText(fresh));
    return 0;
  }
  let committed = '';
  try {
    committed = readFileSync(E2E_CASES_FILE, 'utf8');
  } catch {
    committed = '';
  }
  return check(committed, fresh);
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
