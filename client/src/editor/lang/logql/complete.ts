/**
 * LogQL completion (plan #66 Part A §3.5; T09-007): two `autocomplete` slots. Slot 0, the local
 * slot, answers stages, functions and range durations synchronously from static lists, so its
 * popup opens in the keystroke's task (T09 §7). Slot 1, the remote slot, answers label names,
 * label values and grouping labels through a `LogSource`: it waits 120 ms itself (`afterQuiet`,
 * restarted by every document change), and the fetch it starts belongs to the view's
 * `RemoteLookups` (`../../remoteLookups`, shared with PromQL since #107), which releases it once
 * the caret context leaves its key (`logqlLookupKeyAt`). Every context belongs
 * to exactly one slot; the other returns `null` synchronously, so CodeMirror never merges local
 * and remote options. Accepting an option replaces the whole token or value under the caret,
 * re-measured at accept time (`replacing`).
 */
import {
  insertCompletionText,
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { EditorState, Text } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { afterQuiet, REMOTE_DEBOUNCE_MS, type RemoteLookups } from '../../remoteLookups';
import type { CompletionTiming } from '../../view';
import type { LogSource } from '../types';
import { caretContext, type LogCaretContext } from './context';
import { FUNCTIONS, STAGES } from './grammar';

export const LOGQL_DURATIONS: readonly string[] = Object.freeze([
  '1m',
  '5m',
  '10m',
  '15m',
  '30m',
  '1h',
  '6h',
  '12h',
  '24h',
]);

/** The LogQL view's timing: both slots start in the keystroke's task. */
export const LOGQL_COMPLETION: CompletionTiming = { typingDelayMs: 0, slots: 2 };

const WORD = /^[A-Za-z_]*$/;
const NAME = /^[A-Za-z0-9_]*$/;
const DURATION = /^[0-9a-zµ]*$/;
const IN_DOUBLE = /^[^"\\]*$/;
const IN_BACKTICK = /^[^`]*$/;

/** `\` → `\\`, `"` → `\"`, LF → `\n`, CR → `\r`, tab → `\t`. */
export function escapeDoubleQuoted(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

let memo: { readonly doc: Text; readonly pos: number; readonly c: LogCaretContext } | null = null;

/** The caret context, memoised by document and position: one lex per keystroke for both slots. */
function contextAt(state: EditorState, pos: number): LogCaretContext {
  if (memo !== null && memo.doc === state.doc && memo.pos === pos) return memo.c;
  const c = caretContext(state.doc.toString(), pos);
  memo = { doc: state.doc, pos, c };
  return c;
}

/**
 * An option's `apply`, re-measured on the current document: `c = caretContext(doc, to)`; when
 * `c.kind === kind`, replaces [from, c.end) with `text` plus `c.quote` if `c.closeQuote`; else
 * replaces [from, to) with `text`. The caret ends after the inserted text.
 */
export function replacing(
  text: string,
  kind: LogCaretContext['kind'],
): NonNullable<Completion['apply']> {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const c = caretContext(view.state.doc.toString(), to);
    let end = to;
    let insert = text;
    if (c.kind === kind && c.kind !== 'none') {
      end = c.end;
      if (c.kind === 'labelValue' && c.closeQuote && c.quote !== null) insert += c.quote;
    }
    view.dispatch({
      ...insertCompletionText(view.state, insert, from, end),
      annotations: pickedCompletion.of(completion),
    });
  };
}

function words(
  c: Extract<LogCaretContext, { from: number }>,
  pos: number,
  list: readonly string[],
  type: string,
  validFor: RegExp,
): CompletionResult {
  return {
    from: c.from,
    to: pos,
    options: list.map((w) => ({ label: w, type, apply: replacing(w, c.kind) })),
    validFor,
  };
}

/** Slot 0: stage, function, duration. Synchronous: returns a result or null, never a promise. */
export function logqlLocalSource(): CompletionSource {
  return (ctx) => {
    const c = contextAt(ctx.state, ctx.pos);
    switch (c.kind) {
      case 'stage':
        return words(c, ctx.pos, STAGES, 'keyword', WORD);
      case 'function':
        return words(c, ctx.pos, FUNCTIONS, 'function', WORD);
      case 'duration':
        return words(c, ctx.pos, LOGQL_DURATIONS, 'constant', DURATION);
      default:
        return null;
    }
  };
}

/** labelName and grouping → `['labels', selector]`; labelValue → `['values', label, selector]`. */
export function lookupKeyOf(c: LogCaretContext): string | null {
  switch (c.kind) {
    case 'labelName':
    case 'grouping':
      return JSON.stringify(['labels', c.selector]);
    case 'labelValue':
      return JSON.stringify(['values', c.label, c.selector]);
    default:
      return null;
  }
}

/** `lookupKeyOf(contextAt(state, pos))`: the LogQL `LookupKeyAt`. */
export function logqlLookupKeyAt(state: EditorState, pos: number): string | null {
  return lookupKeyOf(contextAt(state, pos));
}

type RemoteContext = Extract<LogCaretContext, { kind: 'labelName' | 'labelValue' | 'grouping' }>;

function remoteOptions(c: RemoteContext, values: readonly string[]): Completion[] {
  if (c.kind !== 'labelValue') {
    return values.map((v) => ({ label: v, type: 'property', apply: replacing(v, c.kind) }));
  }
  const text = (v: string) => {
    if (c.quote === '`') return v;
    if (c.quote === '"') return escapeDoubleQuoted(v);
    return `"${escapeDoubleQuoted(v)}"`;
  };
  return values
    .filter((v) => c.quote !== '`' || !v.includes('`'))
    .map((v) => ({ label: v, type: 'text', apply: replacing(text(v), c.kind) }));
}

function remoteValidFor(c: RemoteContext): RegExp | undefined {
  if (c.kind !== 'labelValue') return NAME;
  if (c.quote === '"') return IN_DOUBLE;
  if (c.quote === '`') return IN_BACKTICK;
  return undefined;
}

async function remoteResult(
  ctx: CompletionContext,
  c: RemoteContext,
  key: string,
  source: LogSource,
  lookups: RemoteLookups,
): Promise<CompletionResult | null> {
  if (!(await afterQuiet(ctx, REMOTE_DEBOUNCE_MS))) return null;
  const signal = lookups.signalFor(key);
  let values: readonly string[];
  try {
    values =
      c.kind === 'labelValue'
        ? await source.labelValues(c.label, c.selector, signal)
        : await source.labelNames(c.selector, signal);
  } finally {
    lookups.settled(signal);
  }
  const options = remoteOptions(c, values);
  if (options.length === 0) return null;
  const validFor = remoteValidFor(c);
  return {
    from: c.from,
    to: ctx.pos,
    options,
    ...(validFor === undefined ? {} : { validFor }),
  };
}

/** Slot 1: labelName, labelValue, grouping. null synchronously in any other context. */
export function logqlRemoteSource(source: LogSource, lookups: RemoteLookups): CompletionSource {
  return (ctx) => {
    const c = contextAt(ctx.state, ctx.pos);
    if (c.kind !== 'labelName' && c.kind !== 'labelValue' && c.kind !== 'grouping') return null;
    const key = lookupKeyOf(c);
    if (key === null) return null;
    return remoteResult(ctx, c, key, source, lookups);
  };
}
