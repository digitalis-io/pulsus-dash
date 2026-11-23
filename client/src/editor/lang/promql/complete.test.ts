import {
  acceptCompletion,
  CompletionContext,
  completionStatus,
  currentCompletions,
  selectedCompletion,
  selectedCompletionIndex,
  setSelectedCompletion,
  startCompletion,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { StubApi } from '../../../api/StubApi';
import type { PromValues } from '../../../data/decode';
import '../../../test/editorDom';
import {
  F,
  FH,
  FM,
  FQ,
  fakePromSource,
  pendingPromSource,
  type FakePromData,
} from '../../../test/fakePromSource';
import { destroyViews, viewIn, wait } from '../../../test/viewIn';
import { COMPLETION_PROBE_GLOBAL } from '../../probe';
import { SuggestCache, windowBucket } from '../../suggestCache';
import type { PromSource } from '../types';
import { LOCAL_SECTION, REMOTE_SECTION } from './complete';
import { promqlExtensions } from './extensions';
import { createPromSource } from './promSource';

// Plan #107 §5.1.

/** `marked` without its `‸`, and the caret's index. */
function caretOf(marked: string): { text: string; pos: number } {
  const pos = marked.indexOf('‸');
  if (pos < 0) throw new Error(`no caret in ${marked}`);
  return { text: marked.slice(0, pos) + marked.slice(pos + 1), pos };
}

/** Both `autocomplete` slots at the caret of `marked`, on an explicit context. */
function slots(marked: string, source: PromSource) {
  const { text, pos } = caretOf(marked);
  const state = EditorState.create({
    doc: text,
    selection: { anchor: pos },
    extensions: [promqlExtensions(source)],
  });
  const list = state.languageDataAt<CompletionSource>('autocomplete', pos);
  const run = async (i: number): Promise<CompletionResult | null> => {
    const s = list[i];
    expect(s, `slot ${String(i)}`).toBeDefined();
    if (s === undefined) return null;
    return await s(new CompletionContext(state, pos, true));
  };
  return { pos, run };
}

const labelsOf = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? null;

afterEach(() => {
  destroyViews();
});

describe('unit:promql-completion', () => {
  it('Q1: sum(r‸: statics locally; only metric names remotely', async () => {
    const source = fakePromSource(F);
    const { run } = slots('sum(r‸', source);
    const local = labelsOf(await run(0));
    expect(local).toContain('rate');
    expect(local).toContain('sum');
    expect(local).not.toContain('http_requests_total');
    const r1 = await run(1);
    expect(source.calls).toEqual(['metricNames', 'metadata']);
    expect(labelsOf(r1)).toEqual(['http_requests_total', 'up']);
    expect(r1?.options[0]?.detail).toBe('counter');
  });

  it('Q2: up{job="‸"}: an empty local result; label values remotely', async () => {
    const source = fakePromSource(F);
    const { run } = slots('up{job="‸"}', source);
    const r0 = await run(0);
    expect(r0?.options).toEqual([]);
    expect(r0?.from).toBe(8);
    const r1 = await run(1);
    expect(source.calls).toEqual(['labelValues job up']);
    expect(labelsOf(r1)).toEqual(['api']);
  });

  it('Q3: rate(up[5‸: the duration units locally; no lookup', async () => {
    const source = fakePromSource(F);
    const { run } = slots('rate(up[5‸', source);
    const local = labelsOf(await run(0));
    expect(local).toHaveLength(7);
    expect(local).toContain('m');
    expect(await run(1)).toBeNull();
    expect(source.calls).toEqual([]);
  });

  it('Q4: sum by (‸: an empty local result; label names remotely', async () => {
    const source = fakePromSource(F);
    const { run } = slots('sum by (‸', source);
    expect((await run(0))?.options).toEqual([]);
    const r1 = await run(1);
    expect(source.calls).toEqual(['labelNames null']);
    expect(labelsOf(r1)).toEqual(['instance', 'job']);
  });

  it('Q5: up o‸: keywords locally; no lookup', async () => {
    const source = fakePromSource(F);
    const { run } = slots('up o‸', source);
    const local = labelsOf(await run(0));
    expect(local).toContain('or');
    expect(local).toContain('offset');
    expect(await run(1)).toBeNull();
    expect(source.calls).toEqual([]);
  });

  it('Q6: htt‸p_requests_tot: both results end at the caret', async () => {
    const { run } = slots('htt‸p_requests_tot', fakePromSource(F));
    const r0 = await run(0);
    const r1 = await run(1);
    expect([r0?.from, r0?.to]).toEqual([0, 3]);
    expect([r1?.from, r1?.to]).toEqual([0, 3]);
  });

  it('Q7: every result ends at the caret, in its own section', async () => {
    for (const marked of [
      'sum(r‸',
      'up{job="‸"}',
      'rate(up[5‸',
      'sum by (‸',
      'up o‸',
      'htt‸p_requests_tot',
    ]) {
      const { pos, run } = slots(marked, fakePromSource(F));
      const r0 = await run(0);
      const r1 = await run(1);
      for (const [r, section] of [
        [r0, LOCAL_SECTION],
        [r1, REMOTE_SECTION],
      ] as const) {
        if (r === null) continue;
        expect(r.to, marked).toBe(pos);
        for (const o of r.options) expect(o.section, `${marked} ${o.label}`).toBe(section);
      }
    }
  });

  it('Q8: the recording run sends nothing', async () => {
    const source = fakePromSource(F);
    const { run } = slots('sum(r‸', source);
    await run(0);
    expect(source.calls).toEqual([]);
  });

  it('Q9: up == b‸: a static keyword is not repeated remotely', async () => {
    const source = fakePromSource(F);
    const { run } = slots('up == b‸', source);
    expect(labelsOf(await run(0))).toContain('bool');
    expect(labelsOf(await run(1))).toEqual(['http_requests_total', 'up']);
  });
});

const shownLabels = (view: EditorView) => currentCompletions(view.state).map((c) => c.label);

describe('unit:promql-replace (through the view)', () => {
  const rows: [string, FakePromData, string, string[] | { includes: string }, string, string][] = [
    ['R1', FM, '{app="w‸rong"}', ['web'], 'web', '{app="web‸"}'],
    ['R2', FM, 'up{app="w‸rong"}', ['web'], 'web', 'up{app="web‸"}'],
    ['R3', FM, "up{app='w‸rong'}", ['web'], 'web', "up{app='web‸'}"],
    ['R4', FM, 'up{app=`w‸rong`}', ['web'], 'web', 'up{app=`web‸`}'],
    ['R5', FM, 'up{app="w‸rong", env="x"}', ['web'], 'web', 'up{app="web‸", env="x"}'],
    ['R6', FM, 'up{app="w‸rong', ['web'], 'web', 'up{app="web"‸'],
    ['R7', FM, 'up{app="w‸rong}', ['web'], 'web', 'up{app="web"‸}'],
    ['R8', FM, 'up{app="w‸rong, x="1"}', ['web'], 'web', 'up{app="web"‸, x="1"}'],
    ['R9', FM, 'up{app="w‸rong"', ['web'], 'web', 'up{app="web‸"'],
    ['R10', FM, 'up{app="w‸x, y"}', ['web'], 'web', 'up{app="web‸"}'],
    ['R11', FM, 'up{ap‸xx="v"}', ['app'], 'app', 'up{app‸="v"}'],
    [
      'R12',
      FM,
      'htt‸p_requests_tot{job="a"}',
      { includes: 'http_requests_total' },
      'http_requests_total',
      'http_requests_total‸{job="a"}',
    ],
    ['R13', FM, 'sum by (jo‸x) (up)', ['job'], 'job', 'sum by (job‸) (up)'],
    ['R14', F, 'up{job="‸"}', ['api'], 'api', 'up{job="api‸"}'],
    ['R15', FQ, 'up{app="‸"}', ['a"b'], 'a"b', 'up{app="a\\"b‸"}'],
    ['R16', FM, 'up{app="w‸x\\"z', ['web'], 'web', 'up{app="web"‸'],
    ['R17', FM, 'up{app="w‸x\\"}', ['web'], 'web', 'up{app="web"‸}'],
    ['R18', FM, 'up{app="w‸x\\\\"}', ['web'], 'web', 'up{app="web‸"}'],
  ];
  for (const [id, data, marked, shown, pick, result] of rows) {
    it(`${id}: ${marked} → ${result}`, async () => {
      const { text, pos } = caretOf(marked);
      const { view } = viewIn({ doc: text, caret: pos, source: fakePromSource(data) });
      startCompletion(view);
      await vi.waitFor(() => {
        expect(shownLabels(view)).toContain(pick);
      });
      await wait(80); // CodeMirror's 75 ms interaction delay
      const labels = shownLabels(view);
      if (Array.isArray(shown)) expect(new Set(labels)).toEqual(new Set(shown));
      else expect(labels).toContain(shown.includes);
      view.dispatch({ effects: setSelectedCompletion(labels.indexOf(pick)) });
      expect(acceptCompletion(view)).toBe(true);
      const want = caretOf(result);
      expect(view.state.doc.toString()).toBe(want.text);
      expect(view.state.selection.main.head).toBe(want.pos);
    });
  }
});

/** One typed character at the caret, as CodeMirror's input handler dispatches it. */
function type(view: EditorView, ch: string): void {
  const at = view.state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: ch },
    selection: { anchor: at + ch.length },
    userEvent: 'input.type',
  });
}

/** Runs every pending microtask under fake timers. */
const settle = () => vi.advanceTimersByTimeAsync(0);
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

const g = globalThis as Record<string, unknown>;

describe('unit:promql-completion-timing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
    Reflect.deleteProperty(g, COMPLETION_PROBE_GLOBAL);
  });

  /**
   * `sum(‸`, key `h`, 1 ms. (`h`, not the plan's `r`: CodeMirror matches a one-character pattern
   * at the start of a label only, so no metric of `F` would follow `r`.)
   */
  async function p1() {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'sum(', caret: 4, source });
    type(view, 'h');
    await advance(1);
    return { view, source };
  }

  it('P1: the local list opens within 1 ms, with no lookup', async () => {
    const { view, source } = await p1();
    // Open while slot 1 waits: CodeMirror reports a pending slot as 'pending'.
    expect(completionStatus(view.state)).toBe('pending');
    expect(shownLabels(view)).toContain('histogram_quantile');
    expect(shownLabels(view)).not.toContain('http_requests_total');
    expect(source.calls).toEqual([]);
  });

  it('P2, P3: the lookup starts at 120 ms; its options come below the local ones', async () => {
    const { view, source } = await p1();
    const before = shownLabels(view);
    await advance(118);
    expect(source.calls).toEqual([]);
    await advance(1);
    await settle();
    expect(source.calls).toEqual(['metricNames', 'metadata']);
    const labels = shownLabels(view);
    expect(labels.at(-1)).toBe('http_requests_total');
    expect(labels.slice(0, -1)).toEqual(before);
  });

  it('P4: a label value lookup waits 120 ms', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job=""}', caret: 8, source });
    type(view, 'a');
    await advance(119);
    expect(source.calls).toEqual([]);
    expect(completionStatus(view.state)).toBe('pending');
    await advance(1);
    await settle();
    expect(source.calls).toEqual(['labelValues job up']);
  });

  it('P5: every keystroke restarts the wait', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job=""}', caret: 8, source });
    type(view, 'a');
    await advance(60);
    type(view, 'b');
    await advance(119);
    expect(source.calls).toEqual([]);
    await advance(1);
    await settle();
    expect(source.calls).toHaveLength(1);
  });

  it('P6: an explicit start looks up at once', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job=""}', caret: 8, source });
    startCompletion(view);
    await advance(50);
    await settle();
    expect(source.calls).toHaveLength(1);
  });

  it('P7: a late result keeps the selection and every item above it (T09-008)', async () => {
    const { view } = await p1();
    view.dispatch({ effects: setSelectedCompletion(2) });
    const l = selectedCompletion(view.state)?.label;
    const top = shownLabels(view).slice(0, 3);
    await advance(120);
    await settle();
    expect(selectedCompletionIndex(view.state)).toBe(2);
    expect(selectedCompletion(view.state)?.label).toBe(l);
    expect(shownLabels(view).slice(0, 3)).toEqual(top);
  });

  /** The probe's `slot0` calls. */
  const slot0Calls = (probe: Mock) => probe.mock.calls.filter((c) => c[1] === 'slot0').length;

  it('P9: a remote-only list gains no late local result; narrowing keeps the selection', async () => {
    const probe = vi.fn();
    g[COMPLETION_PROBE_GLOBAL] = probe;
    const { view } = viewIn({ doc: 'http', caret: 4, source: fakePromSource(FH) });
    probe.mockClear();
    type(view, '_');
    await advance(1);
    expect(completionStatus(view.state)).not.toBe('active');
    await advance(120);
    await settle();
    expect(shownLabels(view)).toEqual(['http_a', 'http_b']);
    view.dispatch({ effects: setSelectedCompletion(1) });
    await advance(1000);
    await settle();
    expect(shownLabels(view)).toEqual(['http_a', 'http_b']);
    expect(selectedCompletion(view.state)?.label).toBe('http_b');
    type(view, 'b');
    await advance(1);
    await settle();
    expect(shownLabels(view)).toEqual(['http_b']);
    expect(selectedCompletion(view.state)?.label).toBe('http_b');
    expect(slot0Calls(probe)).toBe(1);
  });

  it('P10: the empty local result is kept with the remote one', async () => {
    const probe = vi.fn();
    g[COMPLETION_PROBE_GLOBAL] = probe;
    const { view } = viewIn({ doc: 'up{job=""}', caret: 8, source: fakePromSource(FH) });
    probe.mockClear();
    type(view, 'a');
    await advance(120);
    await settle();
    expect(shownLabels(view)).toEqual(['a1', 'a2']);
    view.dispatch({ effects: setSelectedCompletion(1) });
    type(view, '2');
    await advance(1);
    await settle();
    expect(shownLabels(view)).toEqual(['a2']);
    expect(selectedCompletion(view.state)?.label).toBe('a2');
    expect(slot0Calls(probe)).toBe(1);
  });
});

describe('unit:promql-cancel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** "First call": `up{job="‸"}`, key `a`, 120 ms, settle. */
  async function firstCall() {
    const pending = pendingPromSource();
    const { view } = viewIn({ doc: 'up{job=""}', caret: 8, source: pending.source });
    type(view, 'a');
    await advance(120);
    await settle();
    const { held } = pending;
    expect(held).toHaveLength(1);
    expect(held[0]?.call).toBe('labelValues job up');
    expect(held[0]?.signal.aborted).toBe(false);
    return { view, held };
  }

  it('Y1: a key of the same lookup releases it at once; the next starts 120 ms later', async () => {
    const { view, held } = await firstCall();
    type(view, 'b');
    expect(held[0]?.signal.aborted).toBe(true);
    await advance(119);
    await settle();
    expect(held).toHaveLength(1);
    await advance(1);
    await settle();
    expect(held).toHaveLength(2);
    expect(held[1]?.call).toBe('labelValues job up');
    expect(held[1]?.signal).not.toBe(held[0]?.signal);
    expect(held[1]?.signal.aborted).toBe(false);
  });

  it('Y2: a change to another key releases it at once', async () => {
    const { view, held } = await firstCall();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'up{instance=""}' },
      selection: { anchor: 13 },
    });
    expect(held[0]?.signal.aborted).toBe(true);
  });

  it('Y3: a change to a context without lookups releases it', async () => {
    const { view, held } = await firstCall();
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'rate(up[5' },
      selection: { anchor: 9 },
    });
    expect(held[0]?.signal.aborted).toBe(true);
  });

  it('Y4: a selection change releases it', async () => {
    const { view, held } = await firstCall();
    view.dispatch({ selection: { anchor: 3 } });
    expect(held[0]?.signal.aborted).toBe(true);
  });

  it('Y5: destroying the view releases it', async () => {
    const { view, held } = await firstCall();
    view.destroy();
    expect(held[0]?.signal.aborted).toBe(true);
  });

  it('Y6: metric names: released by a key, then asked again with a new signal', async () => {
    const pending = pendingPromSource();
    const { view } = viewIn({ doc: 'sum(', caret: 4, source: pending.source });
    type(view, 'r');
    await advance(120);
    await settle();
    const { held } = pending;
    expect(held[0]?.call).toBe('metricNames');
    type(view, 'a');
    expect(held[0]?.signal.aborted).toBe(true);
    await advance(120);
    await settle();
    expect(held[1]?.call).toBe('metricNames');
    expect(held[1]?.signal).not.toBe(held[0]?.signal);
    expect(held[1]?.signal.aborted).toBe(false);
  });

  /** Y10's setup: slot 1 run on a context CodeMirror never aborts. */
  function freshContext() {
    const pending = pendingPromSource();
    const { view } = viewIn({ doc: 'up{job=""}', caret: 8, source: pending.source });
    const slot1 = view.state.languageDataAt<CompletionSource>('autocomplete', 8)[1];
    expect(slot1, 'slot 1').toBeDefined();
    void slot1?.(new CompletionContext(view.state, 8, false, view));
    return { view, held: pending.held };
  }

  it('Y10: a document change during the wait starts no stale lookup', async () => {
    const { view, held } = freshContext();
    await advance(60);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: 'up{job="x"}' },
    });
    await advance(120);
    await settle();
    expect(held).toHaveLength(0);
  });

  it('Y11: destroying the view during the wait starts no lookup', async () => {
    const { view, held } = freshContext();
    await advance(60);
    view.destroy();
    await advance(120);
    await settle();
    expect(held).toHaveLength(0);
  });

  it('Y12: a selection change during the wait starts no stale lookup', async () => {
    const { view, held } = freshContext();
    await advance(60);
    view.dispatch({ selection: { anchor: 3 } });
    await advance(120);
    await settle();
    expect(held).toHaveLength(0);
  });

  it('Y13: with no change the path does start a lookup (control)', async () => {
    const { held } = freshContext();
    await advance(120);
    await settle();
    expect(held).toHaveLength(1);
  });

  describe('the real stack', () => {
    const W = { fromMs: Date.UTC(2026, 10, 19, 12), toMs: Date.UTC(2026, 10, 19, 13) };
    const C0 = {
      truncated: false,
      warnings: [],
      infos: [],
      queryId: null,
      dataAgeMs: null,
      readCache: null,
      readCacheThroughMs: null,
    };
    interface Req {
      readonly name: string;
      readonly signal: AbortSignal;
      release(): void;
    }
    let api: StubApi;
    let reqs: Req[];
    let spy: Mock<StubApi['promLabelValues']>;

    beforeEach(() => {
      api = new StubApi();
      reqs = [];
      spy = vi.spyOn(api, 'promLabelValues').mockImplementation(
        (_tenant, name, _req, signal) =>
          new Promise<PromValues>((resolve, reject) => {
            if (signal === undefined) throw new Error('no signal');
            signal.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
            reqs.push({
              name,
              signal,
              release: () => {
                resolve({ values: ['api', 'checkout'], completeness: C0 });
              },
            });
          }),
      );
    });

    const stack = (cache = new SuggestCache()) => ({
      cache,
      source: createPromSource({
        api,
        queryClient: new QueryClient(),
        tenant: 'demo',
        window: () => W,
        cache,
      }),
    });
    const jobKey = {
      tenant: 'demo',
      lang: 'promql' as const,
      kind: 'values' as const,
      label: 'job',
      selector: 'up',
      bucket: windowBucket(W.toMs),
    };
    /** A view's "call": its doc, key `a`, 120 ms, settle. */
    async function call(doc: string, caret: number, source: PromSource): Promise<EditorView> {
      const { view } = viewIn({ doc, caret, source });
      type(view, 'a');
      await advance(120);
      await settle();
      return view;
    }

    it('Y7: one view: a key aborts the request, uncached; the next one is live', async () => {
      const { cache, source } = stack();
      const view = await call('up{job=""}', 8, source);
      type(view, 'b');
      expect(reqs[0]?.signal.aborted).toBe(true);
      expect(cache.has(jobKey)).toBe(false);
      await advance(120);
      await settle();
      expect(spy).toHaveBeenCalledTimes(2);
      expect(reqs[1]?.signal.aborted).toBe(false);
    });

    it('Y8: two views on two keys both complete', async () => {
      const { source } = stack();
      const a = await call('up{job=""}', 8, source);
      const b = await call('up{instance=""}', 13, source);
      expect(reqs.map((r) => r.name)).toEqual(['job', 'instance']);
      expect(reqs.map((r) => r.signal.aborted)).toEqual([false, false]);
      for (const r of reqs) r.release();
      await settle();
      await advance(100);
      expect(shownLabels(a)).toContain('api');
      expect(shownLabels(b)).toContain('api');
    });

    it('Y9: a shared request is aborted only at its last release', async () => {
      const first = stack();
      const a = await call('up{job=""}', 8, first.source);
      const b = await call('up{job=""}', 8, first.source);
      expect(reqs).toHaveLength(1);
      type(a, 'b');
      expect(reqs[0]?.signal.aborted).toBe(false);
      await advance(120);
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      a.destroy();
      expect(reqs[0]?.signal.aborted).toBe(false);
      reqs[0]?.release();
      await settle();
      await advance(100);
      expect(shownLabels(b)).toContain('api');

      const second = stack(new SuggestCache());
      const a2 = await call('up{job=""}', 8, second.source);
      const b2 = await call('up{job=""}', 8, second.source);
      const fresh = reqs.slice(1);
      expect(fresh).toHaveLength(1);
      a2.destroy();
      expect(fresh[0]?.signal.aborted).toBe(false);
      b2.dispatch({
        changes: { from: 0, to: b2.state.doc.length, insert: 'up{instance=""}' },
        selection: { anchor: 13 },
      });
      await settle();
      expect(fresh[0]?.signal.aborted).toBe(true);
      expect(second.cache.has(jobKey)).toBe(false);
    });
  });
});
