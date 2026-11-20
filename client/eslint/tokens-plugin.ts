/**
 * ESLint rules of `ci:token-lint` for TypeScript (T01-010, T02-004). Each string literal, and each
 * template literal with every `${…}` replaced by `1`, is classified as a CSS value by
 * `scripts/lib/tokenValue.ts`. `colour.<theme>.<state>` and any non-literal `colour.<theme>[…]` are
 * state-token uses. A comment that disables a `tokens/` rule is itself a finding: there are no
 * inline exceptions.
 *
 * Scope: `state-token`, `colour-literal` and `computed-token-name` everywhere under `src/`;
 * `size-literal` and `duration-literal` in UI code (`src/{app,shell,kit,pages,theme}/`), because
 * `state`, `i18n` and `api` hold the time grammar and interval ids such as `'10s'`.
 */
import type { ESLint, Rule } from 'eslint';
import type * as ESTree from 'estree';
import {
  classifyValue,
  STATE_NAMES,
  TOKEN_MESSAGES,
  type TokenRule,
} from '../scripts/lib/tokenValue.ts';

const UI_DIRS = /^src\/(?:app|shell|kit|pages|theme)\//;
const STATE_ENCODING = /^src\/theme\/stateEncoding\.(?:ts|module\.css)$/;

function relative(context: Rule.RuleContext): string {
  const cwd = context.cwd.replace(/\\/g, '/').replace(/\/$/, '');
  const file = context.filename.replace(/\\/g, '/');
  return file.startsWith(`${cwd}/`) ? file.slice(cwd.length + 1) : file;
}

function applies(rule: TokenRule, rel: string): boolean {
  if (rule === 'state-token') return !STATE_ENCODING.test(rel);
  if (rule === 'size-literal' || rule === 'duration-literal') return UI_DIRS.test(rel);
  return true;
}

function templateText(node: ESTree.TemplateLiteral): string {
  return node.quasis
    .map((q, i) => (q.value.cooked ?? q.value.raw) + (i < node.expressions.length ? '1' : ''))
    .join('');
}

function isColourMember(node: ESTree.Node): boolean {
  // `colour.dark` or `colour[...]`: the object of a `colour.<theme>.<x>` access.
  return (
    node.type === 'MemberExpression' &&
    node.object.type === 'Identifier' &&
    node.object.name === 'colour'
  );
}

function valueRule(rule: TokenRule): Rule.RuleModule {
  return {
    meta: { type: 'problem', docs: { description: TOKEN_MESSAGES[rule] }, schema: [] },
    create(context) {
      const rel = relative(context);
      if (!applies(rule, rel)) return {};
      const check = (node: ESTree.Node, text: string): void => {
        if (classifyValue(text).has(rule)) context.report({ node, message: TOKEN_MESSAGES[rule] });
      };
      const visitors: Rule.RuleListener = {
        Literal(node) {
          if (typeof node.value === 'string') check(node, node.value);
        },
        TemplateLiteral(node) {
          check(node, templateText(node));
        },
      };
      if (rule === 'state-token') {
        visitors.MemberExpression = (node) => {
          if (!isColourMember(node.object)) return;
          const p = node.property;
          const isState =
            (!node.computed && p.type === 'Identifier' && STATE_NAMES.has(p.name)) ||
            (node.computed &&
              p.type === 'Literal' &&
              typeof p.value === 'string' &&
              STATE_NAMES.has(p.value)) ||
            (node.computed && p.type !== 'Literal');
          if (isState) context.report({ node, message: TOKEN_MESSAGES['state-token'] });
        };
      }
      return visitors;
    },
  };
}

const computedTokenName: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'custom property names are never computed' },
    schema: [],
  },
  create(context) {
    return {
      TemplateLiteral(node) {
        node.quasis.forEach((q, i) => {
          const text = q.value.cooked ?? q.value.raw;
          if (i < node.expressions.length && text.endsWith('--')) {
            context.report({ node, message: 'computed custom property name: name the token' });
          }
        });
      },
    };
  },
};

const suppressedTokenRule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: { description: 'token rules cannot be disabled inline' },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const c of context.sourceCode.getAllComments()) {
          if (c.value.includes('eslint-disable') && c.value.includes('tokens/') && c.loc) {
            context.report({ loc: c.loc, message: 'token rules have no inline exceptions' });
          }
        }
      },
    };
  },
};

const plugin = {
  meta: { name: 'tokens' },
  rules: {
    'state-token': valueRule('state-token'),
    'colour-literal': valueRule('colour-literal'),
    'size-literal': valueRule('size-literal'),
    'duration-literal': valueRule('duration-literal'),
    'computed-token-name': computedTokenName,
    'suppressed-token-rule': suppressedTokenRule,
  },
} satisfies ESLint.Plugin;

export const TOKEN_RULE_IDS = Object.keys(plugin.rules).map((r) => `tokens/${r}`);

export default plugin;
