/**
 * PromQL completion (plan #107 §3.3; SRF-027, T09-007, T09-008, T09 §7): two `autocomplete`
 * slots over the package's `HybridComplete`, as LogQL's (#66 Part A).
 *
 * - **Slot 0 (local)** runs the package over a *recording* `PromSource` that answers every lookup
 *   with `[]` (`analysisAt`). That yields the static options (functions, aggregations, keywords,
 *   operators, modifiers, durations, numbers) in the keystroke's task, and records which lookups
 *   the context needs. It holds a result, possibly empty, whenever slot 1 can answer.
 * - **Slot 1 (remote)** answers only when that record is not empty: it waits 120 ms
 *   (`afterQuiet`), then runs the package over the real source with the view's signal
 *   (`RemoteLookups`) and returns only the options the local run did not return.
 *
 * Both results end at the caret, so CodeMirror filters by the text before it; accepting re-measures
 * the replaced range (`replacing`). Local options come first and remote ones in a second hidden
 * section (`LOCAL_SECTION`, `REMOTE_SECTION`), so a late result never moves the highlighted item
 * or any item above it (T09-008).
 */
import {
  CompletionContext,
  type Completion,
  type CompletionResult,
  type CompletionSection,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import type { EditorState, Text } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import type { CompletionProbe } from '../../probe';
import { afterQuiet, REMOTE_DEBOUNCE_MS, type RemoteLookups } from '../../remoteLookups';
import type { CompletionTiming } from '../../view';
import type { PromSource } from '../types';
import { promqlCompleteStrategy } from './promClient';
import { replacing } from './replace';

/**
 * Both slots start in the keystroke's task; a finished local slot is shown at once
 * (`updateSyncMs: 0`: CodeMirror does not hold it for up to 100 ms behind the waiting remote slot).
 */
export const PROMQL_COMPLETION: CompletionTiming = { typingDelayMs: 0, slots: 2, updateSyncMs: 0 };

/** A `PromSource` lookup with its arguments as `toPrometheusClient` passes them; metadata is not one. */
export type PromLookupCall =
  | readonly ['metricNames']
  | readonly ['labelNames', string | null]
  | readonly ['labelValues', string, string | null]
  | readonly ['series', string];

export interface PromAnalysis {
  /** The package's `from`. */
  readonly from: number;
  readonly validFor: CompletionResult['validFor'];
  /** The options of the recording run, exactly as the package returned them (static ones only). */
  readonly statics: readonly Completion[];
  /** The lookups the context needs, in call order. */
  readonly calls: readonly PromLookupCall[];
  /** `JSON.stringify(calls)`; null when `calls` is empty. */
  readonly key: string | null;
}

export const NO_ANALYSIS: PromAnalysis = Object.freeze({
  from: 0,
  validFor: undefined,
  statics: [],
  calls: [],
  key: null,
});

const none = (): Promise<readonly string[]> => Promise.resolve([]);

/** Each lookup pushes its call and resolves `[]`; `metadata()` resolves `{}` and is not recorded. */
export function recordingSource(calls: PromLookupCall[]): PromSource {
  return {
    metricNames: () => {
      calls.push(['metricNames']);
      return none();
    },
    labelNames: (m) => {
      calls.push(['labelNames', m]);
      return none();
    },
    labelValues: (name, m) => {
      calls.push(['labelValues', name, m]);
      return none();
    },
    series: (m) => {
      calls.push(['series', m]);
      return Promise.resolve([]);
    },
    metadata: () => Promise.resolve({}),
  };
}

/** `source` with `signal` passed to every lookup (the caller's own signal argument is ignored). */
export function withSignal(source: PromSource, signal: AbortSignal): PromSource {
  return {
    metricNames: () => source.metricNames(signal),
    labelNames: (m) => source.labelNames(m, signal),
    labelValues: (name, m) => source.labelValues(name, m, signal),
    series: (m) => source.series(m, signal),
    metadata: () => source.metadata(),
  };
}

interface Memo {
  readonly doc: Text;
  readonly tree: Tree;
  readonly pos: number;
  readonly explicit: boolean;
  readonly analysis: Promise<PromAnalysis>;
}

/** One entry: both slots of one request share the recording run. */
let memo: Memo | null = null;

function analyse(state: EditorState, pos: number, explicit: boolean): Promise<PromAnalysis> {
  const calls: PromLookupCall[] = [];
  try {
    const run = promqlCompleteStrategy(recordingSource(calls)).promQL(
      new CompletionContext(state, pos, explicit),
    );
    return Promise.resolve(run).then(
      (r): PromAnalysis =>
        r === null
          ? NO_ANALYSIS
          : {
              from: r.from,
              validFor: r.validFor,
              statics: r.options,
              calls,
              key: calls.length === 0 ? null : JSON.stringify(calls),
            },
      () => NO_ANALYSIS,
    );
  } catch {
    return Promise.resolve(NO_ANALYSIS);
  }
}

/**
 * `promqlCompleteStrategy(recordingSource(calls)).promQL(new CompletionContext(state, pos, explicit))`,
 * memoised in one module-level entry keyed by (state.doc, syntaxTree(state), pos, explicit)
 * (object identity for the first two). A null result or a rejection resolves `NO_ANALYSIS`.
 */
export function analysisAt(
  state: EditorState,
  pos: number,
  explicit: boolean,
): Promise<PromAnalysis> {
  const tree = syntaxTree(state);
  const m = memo;
  if (m?.doc === state.doc && m.tree === tree && m.pos === pos && m.explicit === explicit) {
    return m.analysis;
  }
  const analysis = analyse(state, pos, explicit);
  memo = { doc: state.doc, tree, pos, explicit, analysis };
  return analysis;
}

/** A section header that is never shown (CSSOM only, so the CSP allows it). */
function hiddenHeader(): HTMLElement {
  const el = document.createElement('completion-section');
  el.style.display = 'none';
  el.setAttribute('aria-hidden', 'true');
  return el;
}

/** The static options, first. */
export const LOCAL_SECTION: CompletionSection = { name: 'local', rank: 0, header: hiddenHeader };
/** Lookup results, below every static option. */
export const REMOTE_SECTION: CompletionSection = { name: 'remote', rank: 1, header: hiddenHeader };

function resultOf(
  from: number,
  to: number,
  options: readonly Completion[],
  validFor: CompletionResult['validFor'],
): CompletionResult {
  return { from, to, options, ...(validFor === undefined ? {} : { validFor }) };
}

/**
 * A remote option that repeats a static one. The package returns its module-level option objects
 * from every run, except `offset` and `bool`, which it builds anew each time without a `type`; a
 * lookup result always has one.
 */
function repeatsStatic(
  o: Completion,
  statics: ReadonlySet<Completion>,
  untyped: ReadonlySet<string>,
): boolean {
  return statics.has(o) || (o.type === undefined && untyped.has(o.label));
}

const now = (probe: CompletionProbe | null): number => (probe === null ? 0 : performance.now());

/** Slot 0. `probe` (§3.9) receives the slot's work in ms, or is null. */
export function promqlLocalSource(probe: CompletionProbe | null): CompletionSource {
  return async (ctx) => {
    const t0 = now(probe);
    const a = await analysisAt(ctx.state, ctx.pos, ctx.explicit);
    let r: CompletionResult | null = null;
    if (a.statics.length > 0) {
      r = resultOf(
        a.from,
        ctx.pos,
        a.statics.map((o) => replacing(o, LOCAL_SECTION)),
        a.validFor,
      );
    } else if (a.key !== null) {
      // Empty, so slot 0 holds a result whenever slot 1 can (§4.5).
      r = resultOf(a.from, ctx.pos, [], a.validFor);
    }
    probe?.(performance.now() - t0, 'slot0');
    return r;
  };
}

/** Slot 1. */
export function promqlRemoteSource(
  source: PromSource,
  lookups: RemoteLookups,
  probe: CompletionProbe | null,
): CompletionSource {
  return async (ctx) => {
    const t0 = now(probe);
    const e = lookups.epoch;
    const a = await analysisAt(ctx.state, ctx.pos, ctx.explicit);
    probe?.(performance.now() - t0, 'slot1pre');
    if (a.key === null) return null;
    // A context CodeMirror does not own is never aborted: the epoch catches a change during the wait.
    if (!(await afterQuiet(ctx, REMOTE_DEBOUNCE_MS)) || !lookups.current(e)) return null;
    const signal = lookups.signalFor(a.key);
    let r: CompletionResult | null;
    try {
      r = await promqlCompleteStrategy(withSignal(source, signal)).promQL(ctx);
    } catch {
      return null;
    } finally {
      lookups.settled(signal);
    }
    const t1 = now(probe);
    let out: CompletionResult | null = null;
    if (r !== null) {
      const statics = new Set(a.statics);
      const untyped = new Set(a.statics.filter((o) => o.type === undefined).map((o) => o.label));
      const kept = r.options.filter((o) => !repeatsStatic(o, statics, untyped));
      if (kept.length > 0) {
        out = resultOf(
          r.from,
          ctx.pos,
          kept.map((o) => replacing(o, REMOTE_SECTION)),
          r.validFor,
        );
      }
    }
    probe?.(performance.now() - t1, 'slot1post');
    return out;
  };
}
