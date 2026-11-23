import {
  acceptCompletion,
  completionStatus,
  CompletionContext,
  currentCompletions,
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
  FL,
  FL2,
  fakeLogSource,
  pendingLogSource,
  type FakeLogData,
} from '../../../test/fakeLogSource';
import { CONTEXT_ROWS, caretOf } from '../../../test/logqlContextCases';
import { flush, wait } from '../../../test/viewIn';
import { SuggestCache, windowBucket } from '../../suggestCache';
import { createQueryView } from '../../view';
import type { LogSource } from '../types';
import { escapeDoubleQuoted, LOGQL_COMPLETION, LOGQL_DURATIONS } from './complete';
import { logqlExtensions } from './extensions';
import { FUNCTIONS, STAGES } from './grammar';
import { createLogSource } from './logSource';

// Appendix A.4 of plan #66 Part A.

/** Both slots of the `autocomplete` language data at the caret of `marked`. */
function slots(marked: string, source: LogSource) {
  const { text, pos } = caretOf(marked);
  const state = EditorState.create({
    doc: text,
    selection: { anchor: pos },
    extensions: [logqlExtensions(source)],
  });
  const list = state.languageDataAt<CompletionSource>('autocomplete', pos);
  const run = (i: number) => {
    const s = list[i];
    if (s === undefined) throw new Error(`no slot ${String(i)}`);
    return s(new CompletionContext(state, pos, true));
  };
  return { pos, list, run };
}

const labelsOf = (r: CompletionResult | null) => r?.options.map((o) => o.label) ?? null;

describe('unit:logql-completion', () => {
  const rows: [string, FakeLogData, string, 0 | 1, string[], number, readonly string[]][] = [
    ['K1', FL, '{app="‸"}', 1, ['labelValues app null'], 6, ['checkout', 'web']],
    [
      'K2',
      FL,
      '{env="prod", app="‸"}',
      1,
      ['labelValues app {env="prod"}'],
      18,
      ['checkout', 'web'],
    ],
    ['K3', FL2, '{app="‸"}', 1, ['labelValues app null'], 6, ['a"b', 'x`y']],
    ['K4', FL, '{‸}', 1, ['labelNames null'], 1, ['app', 'pod']],
    ['K5', FL, '{app=‸}', 1, ['labelValues app null'], 5, ['checkout', 'web']],
    ['K6', FL, '{app="web", ‸}', 1, ['labelNames {app="web"}'], 12, ['app', 'pod']],
    ['K7', FL, '{app="web"} | js‸', 0, [], 14, STAGES],
    ['K8', FL, 'cou‸', 0, [], 0, FUNCTIONS],
    ['K9', FL2, '{app=`‸`}', 1, ['labelValues app null'], 6, ['a"b']],
    ['K10', FL, 'rate({a="b"}[‸', 0, [], 13, LOGQL_DURATIONS],
    [
      'K11',
      FL,
      'sum by (‸) (count_over_time({a="b"}[1m]))',
      1,
      ['labelNames {a="b"}'],
      8,
      ['app', 'pod'],
    ],
    ['K13', FL, '{app="$app", ‸}', 1, ['labelNames null'], 13, ['app', 'pod']],
  ];
  for (const [id, data, marked, slot, calls, from, labels] of rows) {
    it(`${id}: ${marked}`, async () => {
      const source = fakeLogSource(data);
      const { pos, run } = slots(marked, source);
      const other = run(slot === 0 ? 1 : 0);
      expect(other).toBeNull();
      const raw = run(slot);
      if (slot === 0) expect(raw).not.toBeInstanceOf(Promise);
      const r = await raw;
      expect(source.calls).toEqual(calls);
      expect(r?.from).toBe(from);
      expect(r?.to).toBe(pos);
      expect(labelsOf(r)).toEqual([...labels]);
    });
  }

  it('K12: a line filter string answers in neither slot', () => {
    const source = fakeLogSource(FL);
    const { run } = slots('{app="web"} |= "‸"', source);
    expect(run(0)).toBeNull();
    expect(run(1)).toBeNull();
    expect(source.calls).toEqual([]);
  });

  it('K1 with an empty source: the remote slot is null', async () => {
    const { run } = slots('{app="‸"}', fakeLogSource({}));
    expect(await run(1)).toBeNull();
  });

  it('every context answers in at most one slot; slot 0 never returns a promise', async () => {
    for (const [id, marked] of CONTEXT_ROWS) {
      const { run } = slots(marked, fakeLogSource(FL));
      const r0 = run(0);
      expect(r0, id).not.toBeInstanceOf(Promise);
      const r1 = await run(1);
      expect(r0 !== null && r1 !== null, id).toBe(false);
    }
  });

  it('escapes a value for a double-quoted string', () => {
    expect(escapeDoubleQuoted('a\\b"c\n')).toBe('a\\\\b\\"c\\n');
    expect(escapeDoubleQuoted('\r\t')).toBe('\\r\\t');
  });
});

const live: { view: EditorView; host: HTMLElement }[] = [];

/** A LogQL view as the host mounts it, caret at `‸`. */
function logView(marked: string, source: LogSource): EditorView {
  const { text, pos } = caretOf(marked);
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const mount = document.createElement('div');
  root.append(mount);
  const view = createQueryView({
    parent: mount,
    root,
    doc: text,
    label: 'LogQL query',
    placeholder: '',
    language: logqlExtensions(source),
    completion: LOGQL_COMPLETION,
    onChange: vi.fn(),
    onRun: vi.fn(),
    onEscape: vi.fn(),
  });
  view.dispatch({ selection: { anchor: pos } });
  live.push({ view, host });
  return view;
}

afterEach(() => {
  for (const v of live.splice(0)) {
    v.view.destroy();
    v.host.remove();
  }
});

const shownLabels = (view: EditorView) => currentCompletions(view.state).map((c) => c.label);

describe('unit:logql-replace', () => {
  const rows: [string, FakeLogData, string, string[] | { includes: string }, string, string][] = [
    ['M1', FL, '{app="w‸rong"}', ['web'], 'web', '{app="web‸"}'],
    ['M2', FL, '{app=`w‸rong`}', ['web'], 'web', '{app=`web‸`}'],
    ['M3', FL, '{app="w‸rong", pod="x"}', ['web'], 'web', '{app="web‸", pod="x"}'],
    ['M4', FL, '{ap‸xx="v"}', ['app'], 'app', '{app‸="v"}'],
    ['M5', FL, '{app=w‸x}', ['web'], 'web', '{app="web"‸}'],
    ['M6', FL, '{app="web"} | js‸xx', ['json'], 'json', '{app="web"} | json‸'],
    [
      'M7',
      FL,
      'rate({a="b"}[1‸0m])',
      ['1m', '10m', '15m', '1h', '12h'],
      '1h',
      'rate({a="b"}[1h‸])',
    ],
    [
      'M8',
      FL,
      'sum by (po‸x) (count_over_time({a="b"}[1m]))',
      ['pod'],
      'pod',
      'sum by (pod‸) (count_over_time({a="b"}[1m]))',
    ],
    [
      'M9',
      FL,
      'cou‸nt_x({a="b"}[1m])',
      { includes: 'count_over_time' },
      'count_over_time',
      'count_over_time‸({a="b"}[1m])',
    ],
    ['M10', FL, '{app="w‸', ['web'], 'web', '{app="web"‸'],
    ['M11', FL, '{app="‸"}', ['checkout', 'web'], 'web', '{app="web‸"}'],
    ['M12', FL2, '{app="x‸yz"}', ['x`y'], 'x`y', '{app="x`y‸"}'],
    ['M13', FL2, '{app="‸"}', ['a"b', 'x`y'], 'a"b', '{app="a\\"b‸"}'],
    ['M14', FL, '{app="w‸rong', ['web'], 'web', '{app="web"‸'],
    ['M15', FL, '{app="w‸rong}', ['web'], 'web', '{app="web"‸}'],
    ['M16', FL, '{app="w‸rong, x="1"}', ['web'], 'web', '{app="web"‸, x="1"}'],
    ['M17', FL, '{app="w‸rong" | json', ['web'], 'web', '{app="web‸" | json'],
    ['M18', FL, '{app=`w‸rong}', ['web'], 'web', '{app=`web`‸}'],
    ['M19', FL, '{app="w‸rong, x="', ['web'], 'web', '{app="web"‸, x="'],
    ['M20', FL, '{app="w‸x, y"}', ['web'], 'web', '{app="web‸"}'],
    ['M21', FL, '{app="w‸rong"', ['web'], 'web', '{app="web‸"'],
  ];
  for (const [id, data, marked, shown, pick, result] of rows) {
    it(`${id}: ${marked} → ${result}`, async () => {
      const view = logView(marked, fakeLogSource(data));
      startCompletion(view);
      await flush();
      await vi.waitFor(() => {
        expect(completionStatus(view.state)).toBe('active');
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
function key(view: EditorView, ch: string): void {
  const at = view.state.selection.main.head;
  view.dispatch({
    changes: { from: at, insert: ch },
    selection: { anchor: at + ch.length },
    userEvent: 'input.type',
  });
}

/** Runs every pending microtask under fake timers. */
const settle = () => vi.advanceTimersByTimeAsync(0);

describe('unit:logql-cancel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A.4 "first call": `{app="‸"}`, key `w`, 120 ms, flush. */
  async function firstCall(marked = '{app="‸"}') {
    const p = pendingLogSource();
    const view = logView(marked, p.source);
    key(view, 'w');
    await vi.advanceTimersByTimeAsync(120);
    await settle();
    expect(p.held).toHaveLength(1);
    expect(p.held[0]?.signal.aborted).toBe(false);
    return { view, held: p.held };
  }

  it('X1: the same key keeps and shares the in-flight lookup', async () => {
    const { view, held } = await firstCall();
    key(view, 'e');
    expect(held[0]?.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(120);
    await settle();
    expect(held[0]?.signal.aborted).toBe(false);
    expect(held).toHaveLength(2);
    expect(held[1]?.signal).toBe(held[0]?.signal);
  });

  it('X2: a change to another key releases it at once', async () => {
    const { view, held } = await firstCall();
    view.dispatch({ changes: { from: 0, to: 9, insert: '{pod=""}' }, selection: { anchor: 6 } });
    expect(held[0]?.signal.aborted).toBe(true);
  });

  it('X3: a change to a non-remote context releases it', async () => {
    const { view, held } = await firstCall();
    const doc = '{app="w"} |';
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: doc },
      selection: { anchor: doc.length },
    });
    expect(held[0]?.signal.aborted).toBe(true);
  });

  it('X4: a selection move to another key releases it', async () => {
    const { view, held } = await firstCall();
    view.dispatch({ selection: { anchor: 1 } });
    expect(held[0]?.signal.aborted).toBe(true);
  });

  it('X5: destroying the view releases it', async () => {
    const { view, held } = await firstCall();
    view.destroy();
    expect(held[0]?.signal.aborted).toBe(true);
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
    let spy: Mock<StubApi['logLabelValues']>;

    beforeEach(() => {
      api = new StubApi();
      reqs = [];
      spy = vi.spyOn(api, 'logLabelValues').mockImplementation(
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
                resolve({ values: ['checkout', 'web'], completeness: C0 });
              },
            });
          }),
      );
    });

    const stack = (cache = new SuggestCache()) => ({
      cache,
      source: createLogSource({
        api,
        queryClient: new QueryClient(),
        tenant: 'demo',
        window: () => W,
        cache,
      }),
    });
    const appKey = (bucket = windowBucket(W.toMs)) => ({
      tenant: 'demo',
      lang: 'logql' as const,
      kind: 'values' as const,
      label: 'app',
      selector: null,
      bucket,
    });
    /** A view's "call": its doc, key `w`, 120 ms, flush. */
    async function call(marked: string, source: LogSource): Promise<EditorView> {
      const view = logView(marked, source);
      key(view, 'w');
      await vi.advanceTimersByTimeAsync(120);
      await settle();
      return view;
    }

    it('X6: one shared request; released by another key, it is aborted and not cached', async () => {
      const { cache, source } = stack();
      const view = await call('{app="‸"}', source);
      key(view, 'e');
      await vi.advanceTimersByTimeAsync(120);
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      view.dispatch({ changes: { from: 0, to: 9, insert: '{pod=""}' }, selection: { anchor: 6 } });
      expect(reqs[0]?.signal.aborted).toBe(true);
      expect(cache.has(appKey())).toBe(false);
    });

    it('X7: two views of two keys do not abort each other', async () => {
      const { source } = stack();
      const a = await call('{app="‸"}', source);
      const b = await call('{pod="‸"}', source);
      expect(reqs.map((r) => r.name)).toEqual(['app', 'pod']);
      expect(reqs.map((r) => r.signal.aborted)).toEqual([false, false]);
      for (const r of reqs) r.release();
      await settle();
      await vi.advanceTimersByTimeAsync(100);
      expect(shownLabels(a)).toContain('web');
      expect(shownLabels(b)).toContain('web');
    });

    it('X8: an unsignalled caller pins the request', async () => {
      const { cache, source } = stack();
      const pin = source.labelValues('app', null);
      await settle();
      const a = await call('{app="‸"}', source);
      a.dispatch({ changes: { from: 0, to: 9, insert: '{pod=""}' }, selection: { anchor: 6 } });
      const app = reqs.filter((r) => r.name === 'app');
      expect(app).toHaveLength(1);
      expect(app[0]?.signal.aborted).toBe(false);
      app[0]?.release();
      expect(await pin).toEqual(['checkout', 'web']);
      expect(cache.has(appKey())).toBe(true);
    });

    it('X9: a shared request is aborted only at its last release', async () => {
      const first = stack();
      const a = await call('{app="‸"}', first.source);
      const b = await call('{app="‸"}', first.source);
      expect(reqs).toHaveLength(1);
      a.destroy();
      expect(reqs[0]?.signal.aborted).toBe(false);
      reqs[0]?.release();
      await settle();
      await vi.advanceTimersByTimeAsync(100);
      expect(shownLabels(b)).toContain('web');

      const second = stack(new SuggestCache());
      const a2 = await call('{app="‸"}', second.source);
      const b2 = await call('{app="‸"}', second.source);
      const fresh = reqs.slice(1);
      expect(fresh).toHaveLength(1);
      expect(fresh[0]?.name).toBe('app');
      a2.destroy();
      expect(fresh[0]?.signal.aborted).toBe(false);
      b2.dispatch({ changes: { from: 0, to: 9, insert: '{pod=""}' }, selection: { anchor: 6 } });
      expect(fresh[0]?.signal.aborted).toBe(true);
      expect(second.cache.has(appKey())).toBe(false);
    });
  });
});
