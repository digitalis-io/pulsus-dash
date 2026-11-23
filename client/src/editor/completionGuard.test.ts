import {
  autocompletion,
  CompletionContext,
  completionStatus,
  currentCompletions,
  startCompletion,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F, fakePromSource, type FakePromSource } from '../test/fakePromSource';
import { destroyViews, flush, key, viewIn, wait } from '../test/viewIn';
import { completionGuard } from './completionGuard';

// B.4.6, B.4.7 and B.8 #13 of plan #63 Part B.
const bareViews: EditorView[] = [];
afterEach(() => {
  destroyViews();
  for (const v of bareViews.splice(0)) {
    const root = v.root;
    v.destroy();
    if (root instanceof ShadowRoot) root.host.remove();
  }
});

function compose(view: EditorView, phase: 'start' | 'end'): void {
  view.contentDOM.dispatchEvent(
    new CompositionEvent(`composition${phase}`, { bubbles: true, data: '' }),
  );
}

/**
 * The microtask checkpoint a browser runs after the input event, before it dispatches
 * `compositionend` (plan #107: with no typing delay, CodeMirror's own query would otherwise start
 * after a synchronous `compositionend` and look up beside the guard's one re-evaluation).
 */
const settleEvent = () => Promise.resolve();

function typeComposed(view: EditorView, s: string): void {
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from: head, insert: s },
    selection: { anchor: head + s.length },
    userEvent: 'input.type.compose',
  });
}

const labels = (view: EditorView) => currentCompletions(view.state).map((c) => c.label);
const tooltip = (root: ShadowRoot) => root.querySelector('.cm-tooltip-autocomplete');
const lookups = (s: FakePromSource) => s.calls.filter((c) => c.startsWith('labelValues'));

async function active(view: EditorView, timeout = 5000): Promise<void> {
  await vi.waitFor(
    () => {
      expect(completionStatus(view.state)).toBe('active');
    },
    { timeout },
  );
}

/** `fakePromSource(F)` whose first labelValues call settles only on `release()`. */
function deferredSource(): FakePromSource & { release: () => void } {
  const base = fakePromSource(F);
  let first = true;
  let release = (): void => undefined;
  return {
    ...base,
    labelValues: (name, m) => {
      const p = base.labelValues(name, m);
      if (!first) return p;
      first = false;
      return new Promise((r) => {
        release = () => {
          r(p);
        };
      });
    },
    release: () => {
      release();
    },
  };
}

/** A view of `g.extension` and an autocompletion over `g.source(inner)` only. */
function bare(g: ReturnType<typeof completionGuard>, inner: Parameters<typeof g.source>[0]) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const mount = document.createElement('div');
  root.append(mount);
  const view = new EditorView({
    parent: mount,
    root,
    state: EditorState.create({
      doc: 'up{job="',
      selection: { anchor: 8 },
      extensions: [g.extension, autocompletion({ override: [g.source(inner)] })],
    }),
  });
  bareViews.push(view);
  return view;
}

describe('unit:editor-composition', () => {
  it('K1: composition closes the popup and opens none', async () => {
    const source = fakePromSource(F);
    const { view, root } = viewIn({ doc: 'http_requests_tot', caret: 17, source });
    startCompletion(view);
    await active(view);
    const n = source.calls.length;
    compose(view, 'start');
    expect(completionStatus(view.state)).toBeNull();
    typeComposed(view, 'a');
    await wait(300);
    expect(completionStatus(view.state)).toBeNull();
    expect(view.state.doc.toString()).toBe('http_requests_tota');
    expect(source.calls.length).toBe(n);
    startCompletion(view);
    await wait(300);
    expect(completionStatus(view.state)).toBeNull();
    expect(source.calls.length).toBe(n);
    expect(tooltip(root)).toBeNull();
  });

  it('K2 (a): a result arriving while composing is held, then dropped', async () => {
    const g = completionGuard();
    let settle: (r: CompletionResult) => void = () => undefined;
    const inner = vi.fn(
      () =>
        new Promise<CompletionResult>((r) => {
          settle = r;
        }),
    );
    const view = bare(g, inner);
    const ctx = new CompletionContext(view.state, 8, true, view);
    const p = Promise.resolve(g.source(inner)(ctx));
    let done = false;
    let value: unknown;
    void p.then((v) => {
      done = true;
      value = v;
    });
    compose(view, 'start');
    settle({ from: 8, options: [{ label: 'api' }] });
    await flush();
    expect(done).toBe(false);
    compose(view, 'end');
    await flush();
    expect(done).toBe(true);
    expect(value).toBeNull();
  });

  it('K2 (b): a lookup released mid-composition is not shown; one re-evaluation after', async () => {
    const d = deferredSource();
    const { view } = viewIn({ doc: 'up{job="', caret: 8, source: d });
    startCompletion(view);
    await vi.waitFor(() => {
      expect(d.calls).toContain('labelValues job up');
    });
    compose(view, 'start');
    d.release();
    await wait(300);
    expect(completionStatus(view.state)).toBeNull();
    expect(currentCompletions(view.state)).toEqual([]);
    compose(view, 'end');
    await active(view, 1000);
    expect(labels(view)).toContain('api');
    expect(lookups(d)).toEqual(['labelValues job up', 'labelValues job up']);
  });

  it('K3 (a): nothing is accepted while composing', async () => {
    const { view, root } = viewIn({ doc: 'http_requests_tot', caret: 17 });
    startCompletion(view);
    await active(view);
    await wait(100);
    compose(view, 'start');
    expect(runScopeHandlers(view, key({ key: 'Tab' }), 'editor')).toBe(false);
    runScopeHandlers(view, key({ key: 'Enter' }), 'editor');
    expect(view.state.doc.toString()).not.toContain('http_requests_total');
    expect(tooltip(root)).toBeNull();
  });

  it('K3 (b): whenFree refuses while composing', () => {
    const g = completionGuard();
    const view = bare(g, () => null);
    const cmd = vi.fn(() => true);
    compose(view, 'start');
    expect(g.whenFree(cmd)(view)).toBe(false);
    expect(cmd).not.toHaveBeenCalled();
    compose(view, 'end');
    expect(g.whenFree(cmd)(view)).toBe(true);
    expect(cmd).toHaveBeenCalledTimes(1);
  });

  it('K4: one re-evaluation after compositionend', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job="', caret: 8, source });
    compose(view, 'start');
    typeComposed(view, 'a');
    await settleEvent();
    const n = source.calls.length;
    compose(view, 'end');
    await active(view);
    expect(labels(view)).toContain('api');
    expect(source.calls.length).toBe(n + 1);
    expect(source.calls.at(-1)).toBe('labelValues job up');
    await wait(300);
    expect(source.calls.length).toBe(n + 1);
  });

  it('K4 (b): no change, no popup: no re-evaluation', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up', caret: 2, source });
    compose(view, 'start');
    compose(view, 'end');
    await wait(300);
    expect(completionStatus(view.state)).toBeNull();
    expect(source.calls).toEqual([]);
  });

  it('K5: two compositions in a row: one re-evaluation after the last', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job="', caret: 8, source });
    const n = source.calls.length;
    compose(view, 'start');
    typeComposed(view, 'a');
    await settleEvent();
    compose(view, 'end');
    compose(view, 'start');
    typeComposed(view, 'p');
    await settleEvent();
    compose(view, 'end');
    await active(view);
    expect(labels(view)).toContain('api');
    expect(source.calls.length).toBe(n + 1);
    expect(source.calls.at(-1)).toBe('labelValues job up');
    await wait(300);
    expect(source.calls.length).toBe(n + 1);
  });

  it('K6 (a): a changed first composition still refreshes after an empty second', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job="', caret: 8, source });
    const n = source.calls.length;
    compose(view, 'start');
    typeComposed(view, 'a');
    await flush();
    compose(view, 'end');
    compose(view, 'start');
    compose(view, 'end');
    await active(view);
    expect(labels(view)).toContain('api');
    expect(source.calls.length).toBe(n + 1);
    await wait(300);
    expect(source.calls.length).toBe(n + 1);
  });

  it('K6 (b): a popup closed by the first composition reopens after an empty second', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job="', caret: 8, source });
    startCompletion(view);
    await active(view);
    const n = source.calls.length;
    compose(view, 'start');
    expect(completionStatus(view.state)).toBeNull();
    compose(view, 'end');
    compose(view, 'start');
    compose(view, 'end');
    await active(view);
    expect(source.calls.length).toBe(n + 1);
    await wait(300);
    expect(source.calls.length).toBe(n + 1);
  });

  it('K5 (b): the first timer does nothing while a second composition is open', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{job="', caret: 8, source });
    const n = source.calls.length;
    compose(view, 'start');
    typeComposed(view, 'a');
    compose(view, 'end');
    compose(view, 'start');
    typeComposed(view, 'p');
    await wait(30);
    expect(completionStatus(view.state)).toBeNull();
    expect(source.calls.length).toBe(n);
    await wait(300);
    expect(source.calls.length).toBe(n);
    compose(view, 'end');
    await active(view);
    expect(source.calls.length).toBe(n + 1);
  });
});

const docOf = (n: number) => '#' + 'a'.repeat(n - 10) + '\nup{job="';

describe('unit:editor-size', () => {
  for (const n of [131_071, 131_072]) {
    it(`Z1, Z2: ${String(n)} bytes complete`, async () => {
      const source = fakePromSource(F);
      const { view } = viewIn({ doc: docOf(n), source });
      startCompletion(view);
      await active(view);
      expect(source.calls).toContain('labelValues job up');
      expect(labels(view)).toContain('api');
    });
  }

  it('Z3, Z5: over the limit completion pauses, editing goes on; shortening resumes', async () => {
    const source = fakePromSource(F);
    const onChange = vi.fn();
    const onRun = vi.fn();
    const doc = docOf(131_073);
    const { view } = viewIn({ doc, source, onChange, onRun });
    startCompletion(view);
    await wait(300);
    expect(completionStatus(view.state)).toBeNull();
    expect(source.calls).toEqual([]);
    view.dispatch({
      changes: { from: doc.length, insert: 'x' },
      selection: { anchor: doc.length + 1 },
      userEvent: 'input.type',
    });
    expect(view.state.doc.length).toBe(doc.length + 1);
    expect(onChange).toHaveBeenLastCalledWith(doc + 'x');
    await wait(300);
    expect(source.calls).toEqual([]);
    undo(view);
    expect(view.state.doc.toString()).toBe(doc);
    runScopeHandlers(view, key({ key: 'Enter', shiftKey: true }), 'editor');
    expect(onRun).toHaveBeenCalledTimes(1);

    view.dispatch({ changes: { from: 1, to: 3 } });
    startCompletion(view);
    await active(view);
    expect(source.calls).toContain('labelValues job up');
  });

  it('Z4: under the limit in characters, over it in bytes, pauses', async () => {
    const source = fakePromSource(F);
    const doc = '#' + 'あ'.repeat(43_688) + '\nup{job="';
    expect(doc.length).toBe(43_698);
    const { view } = viewIn({ doc, source });
    startCompletion(view);
    await wait(300);
    expect(completionStatus(view.state)).toBeNull();
    expect(source.calls).toEqual([]);
  });

  it('Z6: growing past the limit closes the popup', async () => {
    const source = fakePromSource(F);
    const { view } = viewIn({ doc: docOf(131_072), source });
    startCompletion(view);
    await active(view);
    const n = source.calls.length;
    view.dispatch({ changes: { from: 1, insert: 'a' } });
    await vi.waitFor(() => {
      expect(completionStatus(view.state)).toBeNull();
    });
    expect(source.calls.length).toBe(n);
  });
});
