/**
 * The completion client of PromQL (plan #63 Part B §3.4; SRF-027, T09-007): the package's
 * `HybridComplete` over a `PrometheusClient` that adapts a `PromSource`. The enclosing matchers are
 * read from the request's own Lezer tree. The selector sent leaves out exactly the matcher under
 * the caret and copies every other one as typed (delimiters and escapes); the edited label's name
 * is decoded. If the package's matcher list differs from the tree's, nothing is sent.
 */
import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import {
  newCompleteStrategy,
  type CompleteStrategy,
  type PrometheusClient,
} from '@prometheus-io/codemirror-promql';
import {
  EqlRegex,
  EqlSingle,
  LabelMatchers,
  LabelName,
  MatchOp,
  Neq,
  NeqRegex,
  QuotedLabelMatcher,
  QuotedLabelName,
  StringLiteral,
  UnquotedLabelMatcher,
} from '@prometheus-io/lezer-promql';
import type { PromSource } from '../types';

/**
 * One matcher of the enclosing `LabelMatchers`. `type`, `name` and `value` are the package's
 * projection (its `createMatcher`); `nameText` and `valueText` are source slices.
 */
export interface RawMatcher {
  readonly type: number;
  readonly name: string;
  readonly value: string;
  readonly nameText: string;
  readonly valueText: string;
}

/** The matchers in the package's order; `edited` is the index of the one under the caret, or −1. */
export interface MatcherContext {
  readonly matchers: readonly RawMatcher[];
  readonly edited: number;
}

export const NO_MATCHERS: MatcherContext = Object.freeze({ matchers: [], edited: -1 });

type Matchers = Parameters<PrometheusClient['labelValues']>[2];

function readMatcher(n: SyntaxNode, state: EditorState): RawMatcher {
  const slice = (x: SyntaxNode) => state.sliceDoc(x.from, x.to);
  if (n.type.id === QuotedLabelName) {
    const s = slice(n);
    return {
      type: EqlSingle,
      name: '__name__',
      nameText: '__name__',
      value: s.slice(1, -1),
      valueText: s,
    };
  }
  let type = 0;
  let name = '';
  let nameText = '';
  let value = '';
  let valueText = '""';
  for (let c = n.firstChild; c !== null; c = c.nextSibling) {
    switch (c.type.id) {
      case LabelName:
        name = nameText = slice(c);
        break;
      case QuotedLabelName:
        nameText = slice(c);
        name = nameText.slice(1, -1);
        break;
      case MatchOp:
        type = c.firstChild?.type.id ?? type;
        break;
      case StringLiteral:
        valueText = slice(c);
        value = valueText.slice(1, -1);
        break;
    }
  }
  return { type, name, value, nameText, valueText };
}

/** The matchers around `pos`, read as the package reads them (B.4.5). */
export function matcherContextAt(state: EditorState, pos: number): MatcherContext {
  let edited: SyntaxNode | null = null;
  let lm: SyntaxNode | null = null;
  for (let n: SyntaxNode | null = syntaxTree(state).resolve(pos, -1); n !== null; n = n.parent) {
    const id = n.type.id;
    if (edited === null && (id === UnquotedLabelMatcher || id === QuotedLabelMatcher)) edited = n;
    if (id === LabelMatchers) {
      lm = n;
      break;
    }
  }
  if (lm === null) return NO_MATCHERS;
  const kids = [QuotedLabelName, QuotedLabelMatcher, UnquotedLabelMatcher].flatMap((k) =>
    lm.getChildren(k),
  );
  const ed = edited;
  return {
    matchers: kids.map((k) => readMatcher(k, state)),
    edited: ed === null ? -1 : kids.findIndex((k) => k.from === ed.from && k.to === ed.to),
  };
}

function opOf(type: number): string {
  switch (type) {
    case Neq:
      return '!=';
    case EqlRegex:
      return '=~';
    case NeqRegex:
      return '!~';
    default:
      return '=';
  }
}

/**
 * Every matcher except index `edited`, printed from its source text (T09-007: `job=""` stays);
 * with none kept, the bare metric (or null) instead of `metric{}`.
 */
export function selectorOf(
  metric: string | undefined,
  matchers: readonly RawMatcher[],
  edited: number,
): string | null {
  const kept = matchers
    .filter((_, i) => i !== edited)
    .map((m) => `${m.nameText}${opOf(m.type)}${m.valueText}`);
  if (kept.length === 0) return metric !== undefined && metric !== '' ? metric : null;
  return `${metric ?? ''}{${kept.join(',')}}`;
}

const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SIMPLE: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  f: 12,
  n: 10,
  r: 13,
  t: 9,
  v: 11,
  '\\': 92,
};
const HEX = /^[0-9A-Fa-f]+$/;
const OCT = /^[0-7]{3}$/;

/** UTF-8 bytes of code point `cp`, or null for a surrogate or a value past U+10FFFF. */
function codePointBytes(cp: number): number[] | null {
  if ((cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff) return null;
  return [...new TextEncoder().encode(String.fromCodePoint(cp))];
}

/**
 * The label name a name slice denotes: a bare identifier as is; a backtick-quoted one as is; a
 * `"`- or `'`-quoted one unquoted as PromQL (Go) does; null if it is neither or does not decode.
 */
export function decodeLabelName(nameText: string): string | null {
  if (BARE.test(nameText)) return nameText;
  const q = nameText[0];
  if (nameText.length < 2 || (q !== '"' && q !== "'" && q !== '`') || !nameText.endsWith(q)) {
    return null;
  }
  const inner = nameText.slice(1, -1);
  if (q === '`') return inner.includes('`') ? null : inner;
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  let i = 0;
  while (i < inner.length) {
    const c = inner[i] ?? '';
    if (c === q || c === '\n') return null;
    if (c !== '\\') {
      const ch = String.fromCodePoint(inner.codePointAt(i) ?? 0);
      bytes.push(...encoder.encode(ch));
      i += ch.length;
      continue;
    }
    const e = inner[i + 1] ?? '';
    const simple = SIMPLE[e];
    if (simple !== undefined || e === q) {
      bytes.push(simple ?? e.charCodeAt(0));
      i += 2;
      continue;
    }
    if (e === 'x' || e === 'u' || e === 'U') {
      const n = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const digits = inner.slice(i + 2, i + 2 + n);
      if (digits.length !== n || !HEX.test(digits)) return null;
      const v = parseInt(digits, 16);
      if (e === 'x') bytes.push(v);
      else {
        const cp = codePointBytes(v);
        if (cp === null) return null;
        bytes.push(...cp);
      }
      i += 2 + n;
      continue;
    }
    const oct = inner.slice(i + 1, i + 4);
    if (!OCT.test(oct)) return null;
    const v = parseInt(oct, 8);
    if (v > 255) return null;
    bytes.push(v);
    i += 4;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** A `PrometheusClient` over `source` for the completion request whose context is `ctx`. */
export function toPrometheusClient(source: PromSource, ctx: MatcherContext): PrometheusClient {
  const same = (ms: Matchers) => {
    const list = ms ?? [];
    return (
      list.length === ctx.matchers.length &&
      ctx.matchers.every((m, i) => {
        const x = list[i];
        return x !== undefined && x.type === m.type && x.name === m.name && x.value === m.value;
      })
    );
  };
  return {
    labelNames: (metricName) =>
      source.labelNames(metricName ? metricName : null).then((v) => [...v]),
    labelValues: (labelName, metricName, matchers) => {
      const ed = ctx.matchers[ctx.edited];
      if (!same(matchers) || ed === undefined || ed.name !== labelName) return Promise.resolve([]);
      const name = decodeLabelName(ed.nameText);
      if (name === null) return Promise.resolve([]);
      return source
        .labelValues(name, selectorOf(metricName, ctx.matchers, ctx.edited))
        .then((v) => [...v]);
    },
    series: (metricName, matchers) => {
      if (!same(matchers)) return Promise.resolve([]);
      return source
        .series(selectorOf(metricName, ctx.matchers, -1) ?? metricName)
        .then((sets) => sets.map((s) => new Map(Object.entries(s))));
    },
    // The prefix is filtered locally (T09-007).
    metricNames: () => source.metricNames().then((v) => [...v]),
    metricMetadata: () =>
      source
        .metadata()
        .then((m) =>
          Object.fromEntries(
            Object.entries(m).map(([name, list]) => [
              name,
              list.map(({ type, help }) => ({ type, help })),
            ]),
          ),
        ),
    flags: () => Promise.resolve({}),
  };
}

/**
 * The package's completion over `source`, with the context of each request read from its own
 * state, synchronously. `newCompleteStrategy` sees a complete `PrometheusClient`, so it builds a
 * plain `HybridComplete` per request and never its cached HTTP client.
 */
export function promqlCompleteStrategy(source: PromSource): CompleteStrategy {
  return {
    promQL(ctx) {
      const c = toPrometheusClient(source, matcherContextAt(ctx.state, ctx.pos));
      return newCompleteStrategy({ remote: c, maxMetricsMetadata: 10_000 }).promQL(ctx);
    },
  };
}
