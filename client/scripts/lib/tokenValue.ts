/**
 * The one classifier behind `ci:token-lint` (T01-010, T02-004, VL-021). It inspects a CSS value
 * string with `postcss-value-parser` and walks every node, so `var()` fallbacks, nested `var()`,
 * `calc()` and `image-set()` arguments are all visited. Used by the CSS pass of `token-lint.ts` and
 * by the ESLint rules in `eslint/tokens-plugin.ts`.
 */
import valueParser from 'postcss-value-parser';
import { CSS_NAMED_COLOURS } from './cssNamedColours.ts';

export type TokenRule = 'state-token' | 'colour-literal' | 'size-literal' | 'duration-literal';

export const TOKEN_RULES: readonly TokenRule[] = [
  'state-token',
  'colour-literal',
  'size-literal',
  'duration-literal',
];

/** Custom properties that carry state colours; only `stateEncoding.{module.css,ts}` may use them. */
export const STATE_TOKENS: ReadonlySet<string> = new Set([
  '--ok',
  '--watch',
  '--degraded',
  '--failing',
  '--unknown',
]);

/** The state names, as used for `colour.<theme>.<state>` member access. */
export const STATE_NAMES: ReadonlySet<string> = new Set([
  'ok',
  'watch',
  'degraded',
  'failing',
  'unknown',
]);

const COLOUR_FUNCTIONS: ReadonlySet<string> = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
]);

const SIZE_UNITS: ReadonlySet<string> = new Set([
  'px',
  'rem',
  'em',
  'pt',
  'pc',
  'in',
  'cm',
  'mm',
  'q',
  'ch',
  'ex',
]);

const DURATION_UNITS: ReadonlySet<string> = new Set(['ms', 's']);

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** The rules a CSS value string breaks (each at most once). */
export function classifyValue(value: string): Set<TokenRule> {
  const found = new Set<TokenRule>();
  valueParser(value).walk((node) => {
    if (node.type === 'function') {
      const name = node.value.toLowerCase();
      if (name === 'var') {
        const first = node.nodes.find((n) => n.type !== 'space');
        if (first?.type === 'word' && STATE_TOKENS.has(first.value)) found.add('state-token');
      }
      if (COLOUR_FUNCTIONS.has(name)) found.add('colour-literal');
      return;
    }
    if (node.type !== 'word') return;
    const w = node.value;
    if (STATE_TOKENS.has(w)) found.add('state-token');
    if (HEX.test(w) || CSS_NAMED_COLOURS.has(w.toLowerCase())) found.add('colour-literal');
    const u = valueParser.unit(w);
    if (u !== false && u.unit !== '' && Number(u.number) !== 0) {
      const unit = u.unit.toLowerCase();
      if (SIZE_UNITS.has(unit)) found.add('size-literal');
      if (DURATION_UNITS.has(unit)) found.add('duration-literal');
    }
  });
  return found;
}

export const TOKEN_MESSAGES: Readonly<Record<TokenRule, string>> = {
  'state-token': 'state colours are only used through theme/stateEncoding (T02-004)',
  'colour-literal': 'colour literal: use a colour token (T01-010)',
  'size-literal': 'size literal: use a space or size token (T01-010)',
  'duration-literal': 'duration literal: use a motion token (T01-010)',
};
