/**
 * The `security` ESLint rules (plan #198 Part 2a §3.5), in `ci:lint-ts`:
 *
 * - `security/no-iframe` (`ci:no-iframe`; T08-009, VIZ-056), over `src/**` and `e2e/**`: no JSX
 *   `iframe`, `frame`, `frameset`, `object` or `embed`; no `createElement` of those names in any
 *   case; no JSX `srcDoc`, `srcdoc` assignment or `setAttribute('srcdoc')`; no `new DOMParser`
 *   (also `new window.DOMParser`); no `.createContextualFragment(`. Static computed keys
 *   (`document['createElement']('iframe')`) count as the plain name.
 * - `security/no-html-sink` (T18-004), over the same files: no `innerHTML` or `outerHTML`
 *   assignment and no `insertAdjacentHTML` call, by name or by a static computed key.
 * - `security/markdown-boundary` (ADR-0024), over `src/**`: `commonmark` only under
 *   `src/security/sanitise/`; `parse5` and `parse5-sax-parser/feedback` only in `findIframes.ts` and
 *   the sanitise tests; never commonmark's `HtmlRenderer` or `XmlRenderer`; never `minimist`; the
 *   bare `parse5-sax-parser` (`SAXParser`, which needs `node:stream`) only in `findIframes.test.ts`.
 *
 * The rule names are the plugin's own, so no `no-restricted-*` block overrides them.
 */
import type { ESLint, Rule } from 'eslint';
import type * as ESTree from 'estree';

const EMBEDDING = new Set(['iframe', 'frame', 'frameset', 'object', 'embed']);
const SANITISE = /^src\/security\/sanitise\//;
// findIframes.ts, and the type declaration of the alias it imports (feedback.d.ts).
const FIND_IFRAMES = /^src\/security\/sanitise\/(?:findIframes\.ts|feedback\.d\.ts)$/;
const SANITISE_TEST = /^src\/security\/sanitise\/[^/]+\.test\.tsx?$/;
const SAX_TEST = /^src\/security\/sanitise\/findIframes\.test\.ts$/;
const RENDERERS = new Set(['HtmlRenderer', 'XmlRenderer']);
const FEEDBACK = 'parse5-sax-parser/feedback';

function relative(context: Rule.RuleContext): string {
  const cwd = context.cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const file = context.filename.replace(/\\/g, '/');
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}

/** A JSX element name node (typed loosely: `estree` has no JSX types). */
interface JsxName {
  type: string;
  name?: unknown;
}

/**
 * The name a member or call target spells statically: an identifier (`a.b`, `b`), a string literal
 * (`a['b']`) or a template literal without expressions (``a[`b`]``); `null` for a dynamic one.
 */
function staticName(node: ESTree.Node | null | undefined): string | null {
  if (node === null || node === undefined) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? null;
  }
  return null;
}

/** The property name of `a.b`, `a['b']` or ``a[`b`]``; `null` if computed from an expression. */
function memberName(node: ESTree.Node): string | null {
  if (node.type !== 'MemberExpression') return null;
  if (!node.computed) return node.property.type === 'Identifier' ? node.property.name : null;
  return node.property.type === 'Identifier' ? null : staticName(node.property);
}

/** The called or constructed name: `f`, `a.f`, `a['f']`, ``a[`f`]``. */
function calleeName(node: ESTree.Node): string | null {
  return node.type === 'Identifier' ? node.name : memberName(node);
}

const noIframe: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'no embedded documents: iframes, frames, objects, srcdoc, HTML parsing' },
    schema: [],
  },
  create(context) {
    const report = (node: ESTree.Node, what: string): void => {
      context.report({
        node,
        message: `${what} is banned: external content opens as a link in a new tab (ci:no-iframe, T08-009).`,
      });
    };
    return {
      // JSX nodes are not in `estree`; the listener keys are plain selectors.
      JSXOpeningElement(node: ESTree.Node & { name: JsxName }) {
        const n = node.name;
        if (n.type === 'JSXIdentifier' && typeof n.name === 'string' && EMBEDDING.has(n.name)) {
          report(node, `<${n.name}>`);
        }
      },
      JSXAttribute(node: ESTree.Node & { name: JsxName }) {
        const n = node.name;
        if (
          n.type === 'JSXIdentifier' &&
          typeof n.name === 'string' &&
          n.name.toLowerCase() === 'srcdoc'
        ) {
          report(node, 'srcDoc');
        }
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === 'createContextualFragment') report(node, 'createContextualFragment');
        if (name === 'setAttribute' || name === 'setAttributeNS') {
          const attr = staticName(node.arguments[name === 'setAttribute' ? 0 : 1]);
          if (attr?.toLowerCase() === 'srcdoc') report(node, `setAttribute('${attr}')`);
        }
        if (name !== 'createElement' && name !== 'createElementNS') return;
        const tag = staticName(node.arguments[name === 'createElement' ? 0 : 1]);
        if (tag !== null && EMBEDDING.has(tag.toLowerCase()))
          report(node, `createElement('${tag}')`);
      },
      NewExpression(node) {
        // `new DOMParser`, `new window.DOMParser`, `new globalThis['DOMParser']`.
        if (calleeName(node.callee) === 'DOMParser') report(node, 'new DOMParser');
      },
      AssignmentExpression(node) {
        if (memberName(node.left)?.toLowerCase() === 'srcdoc') report(node, 'srcdoc');
      },
    };
  },
};

const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML']);

/**
 * HTML string sinks in every spelling (T18-004, Trusted Types): `innerHTML` and `outerHTML`
 * assignments and `insertAdjacentHTML` calls, by name or by a static computed key. The plain forms
 * are also in `eslint.config.js` `bannedSyntax`; this rule's name is its own, so no
 * `no-restricted-syntax` override drops it.
 */
const noHtmlSink: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'no HTML string sinks, also through static computed keys' },
    schema: [],
  },
  create(context) {
    const report = (node: ESTree.Node, what: string): void => {
      context.report({ node, message: `${what} is banned (Trusted Types, T18-004).` });
    };
    return {
      AssignmentExpression(node) {
        const name = memberName(node.left);
        if (name !== null && HTML_PROPERTIES.has(name)) report(node, `${name} assignment`);
      },
      CallExpression(node) {
        if (calleeName(node.callee) === 'insertAdjacentHTML') report(node, 'insertAdjacentHTML');
      },
    };
  },
};

/** Why `source` may not be imported from `rel`, or null if it may. */
function boundary(source: string, rel: string): string | null {
  if (source === 'minimist' || source.startsWith('minimist/')) {
    return 'minimist is commonmark’s CLI dependency and never reaches the browser (ADR-0024).';
  }
  if (source === 'commonmark' || source.startsWith('commonmark/')) {
    return SANITISE.test(rel)
      ? null
      : 'commonmark is imported only under src/security/sanitise/ (ADR-0024, T24-004).';
  }
  if (
    source === 'parse5-sax-parser' ||
    (source.startsWith('parse5-sax-parser/') && source !== FEEDBACK)
  ) {
    return SAX_TEST.test(rel)
      ? null
      : 'parse5-sax-parser’s SAXParser needs node:stream: use parse5-sax-parser/feedback in findIframes.ts (ADR-0024).';
  }
  if (source === 'parse5' || source.startsWith('parse5/') || source === FEEDBACK) {
    return FIND_IFRAMES.test(rel) || SANITISE_TEST.test(rel)
      ? null
      : `${source} is imported only by src/security/sanitise/findIframes.ts (ADR-0024).`;
  }
  return null;
}

const markdownBoundary: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'the Markdown and HTML parsers stay inside the sanitiser (ADR-0024)' },
    schema: [],
  },
  create(context) {
    const rel = relative(context);
    const source = (node: ESTree.Node, s: ESTree.Node | null | undefined): void => {
      if (s?.type !== 'Literal' || typeof s.value !== 'string') return;
      const why = boundary(s.value, rel);
      if (why !== null) context.report({ node, message: why });
    };
    const renderer = (node: ESTree.Node, name: string): void => {
      if (RENDERERS.has(name)) {
        context.report({
          node,
          message: `commonmark’s ${name} builds an HTML or XML string: render the tree (T24-004).`,
        });
      }
    };
    return {
      ImportDeclaration(node) {
        source(node, node.source);
      },
      ExportNamedDeclaration(node) {
        source(node, node.source);
      },
      ExportAllDeclaration(node) {
        source(node, node.source);
      },
      ImportExpression(node) {
        source(node, node.source);
      },
      ImportSpecifier(node) {
        const imported = node.imported;
        renderer(node, imported.type === 'Identifier' ? imported.name : String(imported.value));
      },
      MemberExpression(node) {
        const p = node.property;
        if (!node.computed && p.type === 'Identifier') renderer(node, p.name);
        else if (p.type === 'Literal' && typeof p.value === 'string') renderer(node, p.value);
      },
      Identifier(node: ESTree.Identifier & Rule.NodeParentExtension) {
        const parent = node.parent;
        // Import specifiers and member properties are reported above.
        if (parent.type === 'ImportSpecifier') return;
        if (parent.type === 'MemberExpression' && parent.property === node) return;
        renderer(node, node.name);
      },
    };
  },
};

const plugin = {
  meta: { name: 'security' },
  rules: {
    'no-iframe': noIframe,
    'no-html-sink': noHtmlSink,
    'markdown-boundary': markdownBoundary,
  },
} satisfies ESLint.Plugin;

export const SECURITY_RULE_IDS = Object.keys(plugin.rules).map((r) => `security/${r}`);

export default plugin;
