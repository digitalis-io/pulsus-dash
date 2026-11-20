/**
 * `ci:dep-audit (build origins)` (T05 §7.1, VL-010, T18-001): the production build loads nothing
 * from another origin. Files are parsed (acorn + eslint-scope for JS, postcss for CSS, parse5 for
 * HTML) and URLs are classified by position, not by origin:
 *
 * - Resource positions (module loads, fetch/worker/URL construction, DOM resource sinks, CSS `url()`,
 *   `@import`, HTML resource attributes): the argument is resolved statically through literals,
 *   templates, `+` and `const` bindings; any absolute or protocol-relative URL fails
 *   (`third-party-resource`), whatever its origin.
 * - Text rule: every URL token in any JS string or template part must equal a `buildUrlAllowlist`
 *   entry (`third-party-host`); a token that runs into a `${…}` fails as `computed-url`. HTML and
 *   CSS have no allowlist.
 * - An allowlist entry that no longer occurs is reported as `unused-url-allowlist` (warning).
 *
 * Usage: node scripts/check-build-origins.ts [dist] [policy]
 * Exit: 0 no errors, 1 findings, 2 a file does not parse.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import { analyze } from 'eslint-scope';
import type { Scope } from 'eslint';
import type * as ESTree from 'estree';
import { parse as parseHtml } from 'parse5';
import postcss from 'postcss';
import valueParser from 'postcss-value-parser';
import { parsePolicy } from './check-deps.ts';
import { InputError, readJson, runCli, type Finding } from './lib/report.ts';

const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url));
// An http(s) URL, or a protocol-relative one (`//` not preceded by `:`, so `server://x` and other
// non-web schemes are not tokens).
const URL_TOKEN = /(?:https?:\/\/|(?<!:)\/\/)[^\s"'`<>()]+/g;
const ABSOLUTE_PREFIX = /^(?:https?:)?\/\//i;
const ABSOLUTE_ANYWHERE = /https?:\/\//i;
const SINK_MEMBERS = new Set(['src', 'href', 'srcset', 'poster', 'action', 'data', 'background']);
const FETCH_CALLS = new Set(['fetch', 'importScripts']);
const NEW_FIRST_ARG = new Set([
  'URL',
  'Worker',
  'SharedWorker',
  'EventSource',
  'WebSocket',
  'Request',
  'Image',
  'Audio',
]);
const HTML_RESOURCE_ATTRS = new Set([
  'src',
  'href',
  'srcset',
  'poster',
  'data',
  'action',
  'formaction',
  'manifest',
]);
const MAX_STEPS = 16;
/**
 * The loopback origin as a URL-parsing base, the only value allowed as the whole first argument of
 * `new URL(…)`: react-router 8 builds `new URL('http://localhost')` to resolve paths. It names no
 * third-party host, and the CSP (`connect-src 'self'`) would block a request to it.
 */
const URL_PARSE_BASES: ReadonlySet<string> = new Set(['http://localhost']);

export interface OriginContext {
  allow: ReadonlySet<string>;
  used: Set<string>;
}

/** URL tokens of a text, with trailing `.,;:` stripped; `end` is the match end before stripping. */
export function urlTokens(text: string): { token: string; index: number; end: number }[] {
  const out: { token: string; index: number; end: number }[] = [];
  for (const m of text.matchAll(URL_TOKEN)) {
    const token = m[0].replace(/[.,;:]+$/, '');
    if (token.length > 2) out.push({ token, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

function finding(rule: string, file: string, line: number, url: string, message: string): Finding {
  return { rule, file, line, subject: url, message: `${message}: ${url}` };
}

// ---------------------------------------------------------------------------------------------
// JavaScript

type Part = { text: string } | null; // null = unknown

function jsTextRule(
  file: string,
  ast: acorn.Program,
  ctx: OriginContext | null,
  lineOffset: number,
  out: Finding[],
): void {
  walk.full(ast, (n) => {
    const node = n as unknown as ESTree.Node & { loc?: acorn.SourceLocation };
    const line = (node.loc?.start.line ?? 0) + lineOffset;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      for (const { token } of urlTokens(node.value)) {
        if (ctx?.allow.has(token) === true) ctx.used.add(token);
        else
          out.push(finding('third-party-host', file, line, token, 'URL not on buildUrlAllowlist'));
      }
    } else if (node.type === 'TemplateLiteral') {
      node.quasis.forEach((q, i) => {
        const text = q.value.cooked ?? q.value.raw;
        const qline = ((q as { loc?: acorn.SourceLocation }).loc?.start.line ?? line) + lineOffset;
        for (const { token, end } of urlTokens(text)) {
          if (i < node.expressions.length && end === text.length) {
            out.push(finding('computed-url', file, qline, token, 'URL computed in a template'));
          } else if (ctx?.allow.has(token) === true) {
            ctx.used.add(token);
          } else {
            out.push(
              finding('third-party-host', file, qline, token, 'URL not on buildUrlAllowlist'),
            );
          }
        }
      });
    }
  });
}

class Resolver {
  private readonly refs = new Map<ESTree.Identifier, Scope.Reference>();

  constructor(manager: Scope.ScopeManager) {
    for (const scope of manager.scopes) {
      for (const ref of scope.references) this.refs.set(ref.identifier, ref);
    }
  }

  private constInit(id: ESTree.Identifier): ESTree.Expression | null {
    const v = this.refs.get(id)?.resolved;
    if (v === null || v === undefined || v.defs.length !== 1) return null;
    const def = v.defs[0];
    if (def?.type !== 'Variable' || def.parent.kind !== 'const') return null;
    if (def.node.id.type !== 'Identifier') return null;
    return def.node.init ?? null;
  }

  resolve(node: ESTree.Node, steps: { n: number }): Part[] {
    if (++steps.n > MAX_STEPS) return [null];
    switch (node.type) {
      case 'Literal':
        return typeof node.value === 'string' || typeof node.value === 'number'
          ? [{ text: String(node.value) }]
          : [null];
      case 'TemplateLiteral': {
        const parts: Part[] = [];
        node.quasis.forEach((q, i) => {
          parts.push({ text: q.value.cooked ?? q.value.raw });
          const e = node.expressions[i];
          if (e !== undefined) parts.push(...this.resolve(e, steps));
        });
        return parts;
      }
      case 'BinaryExpression':
        if (node.operator !== '+' || node.left.type === 'PrivateIdentifier') return [null];
        return [...this.resolve(node.left, steps), ...this.resolve(node.right, steps)];
      case 'Identifier': {
        const init = this.constInit(node);
        return init === null ? [null] : this.resolve(init, steps);
      }
      case 'MemberExpression': {
        if (node.object.type !== 'Identifier') return [null];
        const init = this.constInit(node.object);
        if (init?.type !== 'ObjectExpression') return [null];
        const p = node.property;
        const key =
          !node.computed && p.type === 'Identifier'
            ? p.name
            : p.type === 'Literal'
              ? String(p.value)
              : null;
        if (key === null) return [null];
        for (const prop of init.properties) {
          if (prop.type !== 'Property') continue;
          const k =
            prop.key.type === 'Identifier' && !prop.computed
              ? prop.key.name
              : prop.key.type === 'Literal'
                ? String(prop.key.value)
                : null;
          if (k === key) return this.resolve(prop.value, steps);
        }
        return [null];
      }
      default:
        return [null];
    }
  }
}

/** The URL a resolved sink value reaches, if it is absolute or protocol-relative. */
function absoluteUrl(parts: readonly Part[]): string | null {
  let prefix = '';
  for (const p of parts) {
    if (p === null) break;
    prefix += p.text;
  }
  if (ABSOLUTE_PREFIX.test(prefix)) return prefix;
  for (const p of parts) if (p !== null && ABSOLUTE_ANYWHERE.test(p.text)) return p.text;
  return null;
}

function calleeName(callee: ESTree.Node): {
  name: string | null;
  objectProp: string | null;
  object: string | null;
} {
  if (callee.type === 'Identifier') return { name: callee.name, objectProp: null, object: null };
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    const obj = callee.object;
    const objectProp =
      obj.type === 'MemberExpression' && !obj.computed && obj.property.type === 'Identifier'
        ? obj.property.name
        : null;
    const object = obj.type === 'Identifier' ? obj.name : null;
    return { name: callee.property.name, objectProp, object };
  }
  return { name: null, objectProp: null, object: null };
}

function jsSinks(
  file: string,
  ast: acorn.Program,
  resolver: Resolver,
  lineOffset: number,
  out: Finding[],
): void {
  const check = (arg: ESTree.Node | undefined | null, at: ESTree.Node): void => {
    if (arg === undefined || arg === null || arg.type === 'SpreadElement') return;
    const url = absoluteUrl(resolver.resolve(arg, { n: 0 }));
    if (url !== null) {
      const line = ((at as { loc?: acorn.SourceLocation }).loc?.start.line ?? 0) + lineOffset;
      out.push(
        finding('third-party-resource', file, line, url, 'resource loaded from another origin'),
      );
    }
  };
  const asNode = (n: acorn.Node): ESTree.Node => n as unknown as ESTree.Node;
  walk.simple(ast, {
    ImportExpression(n) {
      const node = asNode(n);
      if (node.type === 'ImportExpression') check(node.source, node);
    },
    ImportDeclaration(n) {
      const node = asNode(n);
      if (node.type === 'ImportDeclaration') check(node.source, node);
    },
    ExportAllDeclaration(n) {
      const node = asNode(n);
      if (node.type === 'ExportAllDeclaration') check(node.source, node);
    },
    ExportNamedDeclaration(n) {
      const node = asNode(n);
      if (node.type === 'ExportNamedDeclaration') check(node.source, node);
    },
    CallExpression(n) {
      const node = asNode(n);
      if (node.type !== 'CallExpression') return;
      const { name, objectProp, object } = calleeName(node.callee);
      if (name === null) return;
      if (FETCH_CALLS.has(name)) check(node.arguments[0], node);
      else if (name === 'sendBeacon' && (object === 'navigator' || objectProp === 'navigator')) {
        check(node.arguments[0], node);
      } else if (name === 'register' && objectProp === 'serviceWorker')
        check(node.arguments[0], node);
      else if (name === 'setAttribute') {
        const a0 = node.arguments[0];
        if (a0?.type === 'Literal' && typeof a0.value === 'string' && SINK_MEMBERS.has(a0.value)) {
          check(node.arguments[1], node);
        }
      }
    },
    NewExpression(n) {
      const node = asNode(n);
      if (node.type !== 'NewExpression') return;
      const { name } = calleeName(node.callee);
      if (name === null) return;
      if (name === 'URL') {
        const a0 = node.arguments[0];
        if (a0 !== undefined && a0.type !== 'SpreadElement') {
          const parts = resolver.resolve(a0, { n: 0 });
          const known = parts.filter((p): p is { text: string } => p !== null);
          const whole = known.length === parts.length ? known.map((p) => p.text).join('') : null;
          if (whole !== null && URL_PARSE_BASES.has(whole)) return;
        }
        check(a0, node);
      } else if (NEW_FIRST_ARG.has(name)) check(node.arguments[0], node);
      else if (name === 'FontFace') for (const a of node.arguments) check(a, node);
    },
    AssignmentExpression(n) {
      const node = asNode(n);
      if (node.type !== 'AssignmentExpression') return;
      const l = node.left;
      if (
        l.type === 'MemberExpression' &&
        !l.computed &&
        l.property.type === 'Identifier' &&
        SINK_MEMBERS.has(l.property.name)
      ) {
        check(node.right, node);
      }
    },
  });
}

function parseJs(file: string, text: string): acorn.Program {
  const opts = {
    ecmaVersion: 'latest',
    locations: true,
    ranges: true,
    allowHashBang: true,
  } as const;
  try {
    return acorn.parse(text, { ...opts, sourceType: 'module' });
  } catch {
    try {
      return acorn.parse(text, { ...opts, sourceType: 'script' });
    } catch (e) {
      throw new InputError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

export function checkJs(
  file: string,
  text: string,
  ctx: OriginContext | null,
  lineOffset = 0,
): Finding[] {
  const ast = parseJs(file, text);
  const manager = analyze(ast, {
    ecmaVersion: 2022,
    sourceType: ast.sourceType,
    fallback: 'iteration',
  });
  const out: Finding[] = [];
  jsSinks(file, ast, new Resolver(manager), lineOffset, out);
  jsTextRule(file, ast, ctx, lineOffset, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// CSS

function cssResourceUrls(value: string): string[] {
  const urls: string[] = [];
  valueParser(value).walk((node) => {
    if (node.type !== 'function') return;
    const name = node.value.toLowerCase();
    if (name === 'url' || name === 'src') {
      const arg = node.nodes.find((n) => n.type !== 'space');
      if (arg !== undefined) urls.push(arg.value);
    } else if (name === 'image-set' || name === '-webkit-image-set') {
      for (const n of node.nodes) if (n.type === 'string') urls.push(n.value);
    }
  });
  return urls;
}

function cssTextRule(file: string, value: string, line: number, out: Finding[]): void {
  for (const { token } of urlTokens(value)) {
    out.push(finding('third-party-host', file, line, token, 'URL in CSS'));
  }
}

export function checkCss(file: string, text: string, lineOffset = 0): Finding[] {
  let root;
  try {
    root = postcss.parse(text, { from: file });
  } catch (e) {
    throw new InputError(`${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const out: Finding[] = [];
  const resource = (urls: readonly string[], line: number): void => {
    for (const u of urls) {
      if (ABSOLUTE_PREFIX.test(u.trim())) {
        out.push(
          finding(
            'third-party-resource',
            file,
            line,
            u.trim(),
            'resource loaded from another origin',
          ),
        );
      }
    }
  };
  root.walkDecls((d) => {
    const line = (d.source?.start?.line ?? 0) + lineOffset;
    resource(cssResourceUrls(d.value), line);
    cssTextRule(file, d.value, line, out);
  });
  root.walkAtRules((a) => {
    const line = (a.source?.start?.line ?? 0) + lineOffset;
    if (a.name.toLowerCase() === 'import') {
      const first = valueParser(a.params).nodes.find((n) => n.type !== 'space');
      if (first?.type === 'string') resource([first.value], line);
    }
    resource(cssResourceUrls(a.params), line);
    cssTextRule(file, a.params, line, out);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// HTML

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: {
    startLine: number;
    attrs?: Record<string, { startLine: number }>;
  } | null;
}

export function checkHtml(file: string, text: string, ctx: OriginContext | null): Finding[] {
  const doc = parseHtml(text, { sourceCodeLocationInfo: true }) as unknown as HtmlNode;
  const out: Finding[] = [];
  const visit = (node: HtmlNode, parentTag: string | null): void => {
    const line = node.sourceCodeLocation?.startLine ?? 0;
    if (node.nodeName === '#text' && node.value !== undefined) {
      if (parentTag === 'script') out.push(...checkJs(file, node.value, ctx, line - 1));
      else if (parentTag === 'style') out.push(...checkCss(file, node.value, line - 1));
      else
        for (const { token } of urlTokens(node.value))
          out.push(finding('third-party-host', file, line, token, 'URL in HTML text'));
    }
    const attrs = node.attrs ?? [];
    for (const a of attrs) {
      const aline = node.sourceCodeLocation?.attrs?.[a.name]?.startLine ?? line;
      const name = a.name.toLowerCase();
      let urls: string[] = [];
      if (HTML_RESOURCE_ATTRS.has(name)) {
        urls =
          name === 'srcset'
            ? a.value.split(',').map((c) => c.trim().split(/\s+/)[0] ?? '')
            : [a.value.trim()];
      } else if (
        name === 'content' &&
        node.tagName === 'meta' &&
        attrs.some(
          (x) => x.name.toLowerCase() === 'http-equiv' && x.value.toLowerCase() === 'refresh',
        )
      ) {
        const m = /url\s*=\s*['"]?([^'"]*)/i.exec(a.value);
        if (m?.[1] !== undefined) urls = [m[1].trim()];
      }
      for (const u of urls) {
        if (ABSOLUTE_PREFIX.test(u))
          out.push(
            finding('third-party-resource', file, aline, u, 'resource loaded from another origin'),
          );
      }
      if (name === 'style') out.push(...checkCss(file, `x{${a.value}}`, aline - 1));
      else
        for (const { token } of urlTokens(a.value))
          out.push(finding('third-party-host', file, aline, token, 'URL in HTML'));
    }
    for (const c of node.childNodes ?? []) visit(c, node.tagName ?? parentTag);
    if (node.content !== undefined) visit(node.content, null);
  };
  visit(doc, null);
  return out;
}

// ---------------------------------------------------------------------------------------------

function listFiles(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFiles(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

export function checkOrigins(
  dist: string,
  allowlist: readonly { url: string }[],
  warnUnused = true,
): Finding[] {
  let files: string[];
  try {
    files = listFiles(dist)
      .filter((f) => !f.startsWith('.vite/'))
      .sort();
  } catch {
    throw new InputError(`cannot read ${dist}: run npm run build`);
  }
  const ctx: OriginContext = { allow: new Set(allowlist.map((a) => a.url)), used: new Set() };
  const out: Finding[] = [];
  for (const f of files) {
    const text = (): string => readFileSync(join(dist, f), 'utf8');
    if (/\.(?:m?js)$/.test(f)) out.push(...checkJs(f, text(), ctx));
    else if (f.endsWith('.css')) out.push(...checkCss(f, text()));
    else if (f.endsWith('.html')) out.push(...checkHtml(f, text(), ctx));
  }
  if (warnUnused) {
    for (const a of allowlist) {
      if (!ctx.used.has(a.url)) {
        out.push({
          rule: 'unused-url-allowlist',
          file: 'dependency-policy.json',
          subject: a.url,
          message: `buildUrlAllowlist entry no longer occurs in the build: ${a.url}`,
          severity: 'warning',
        });
      }
    }
  }
  return out;
}

if (import.meta.main) {
  await runCli(() => {
    const dist = process.argv[2] ?? join(CLIENT_ROOT, 'dist');
    const policy = parsePolicy(
      readJson(process.argv[3] ?? join(CLIENT_ROOT, 'dependency-policy.json')),
    );
    return checkOrigins(dist, policy.buildUrlAllowlist);
  });
}
