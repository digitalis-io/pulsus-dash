import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { undo, undoDepth } from '@codemirror/commands';
import { diagnosticCount, forEachDiagnostic } from '@codemirror/lint';
import { runScopeHandlers, type EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { F, fakePromSource, type FakePromSource } from '../test/fakePromSource';
import { destroyViews, key, viewIn, wait } from '../test/viewIn';
import { EDITOR_PROBE_GLOBAL } from './probe';
import { promqlHighlight } from './theme';
import { insertAtSelection, setDocument, showDiagnostics } from './view';

afterEach(() => {
  destroyViews();
});

const press = (view: EditorView, init: KeyboardEventInit) =>
  runScopeHandlers(view, key(init), 'editor');

async function popup(view: EditorView): Promise<void> {
  startCompletion(view);
  await vi.waitFor(() => {
    expect(completionStatus(view.state)).toBe('active');
  });
  await wait(100); // CodeMirror's 75 ms interaction delay
}

/** The labelValues calls a completion at the end of `doc` makes. */
async function lookupsAtEnd(doc: string): Promise<string[]> {
  const source = fakePromSource(F);
  const { view } = viewIn({ doc, source });
  startCompletion(view);
  await vi.waitFor(() => {
    expect(source.calls.some((c) => c.startsWith('labelValues'))).toBe(true);
  });
  return source.calls.filter((c) => c.startsWith('labelValues'));
}

describe('unit:editor-keys', () => {
  it('Shift+Enter and Mod+Enter run, Enter is a newline, Escape leaves, Tab is not taken', () => {
    const onRun = vi.fn();
    const onEscape = vi.fn();
    const { view } = viewIn({ doc: 'up', caret: 2, source: fakePromSource(F), onRun, onEscape });
    expect(press(view, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(press(view, { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(view.state.doc.toString()).toBe('up');
    press(view, { key: 'Enter' });
    expect(view.state.doc.toString()).toBe('up\n');
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(press(view, { key: 'Escape' })).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(press(view, { key: 'Tab' })).toBe(false);
    expect(view.state.doc.toString()).toBe('up\n');
  });
});

describe('unit:editor-completion', () => {
  it('metric names show their type; Escape closes the popup first; Tab accepts', async () => {
    const onEscape = vi.fn();
    const { view } = viewIn({
      doc: 'http_requests_tot',
      caret: 17,
      source: fakePromSource(F),
      onEscape,
    });
    await popup(view);
    expect(currentCompletions(view.state)).toContainEqual(
      expect.objectContaining({
        label: 'http_requests_total',
        detail: 'counter',
        info: 'Total HTTP requests.',
      }),
    );
    press(view, { key: 'Escape' });
    expect(completionStatus(view.state)).toBeNull();
    expect(onEscape).not.toHaveBeenCalled();
    await popup(view);
    expect(press(view, { key: 'Tab' })).toBe(true);
    expect(view.state.doc.toString()).toBe('http_requests_total');
  });

  it('label values under the enclosing selector; label names after by (', async () => {
    const source: FakePromSource = fakePromSource(F);
    const { view } = viewIn({ doc: 'up{instance="a",job="', source });
    await popup(view);
    expect(source.calls).toContain('labelValues job up{instance="a"}');
    expect(currentCompletions(view.state).map((c) => c.label)).toContain('api');

    const names = fakePromSource(F);
    const by = viewIn({ doc: 'sum by (', source: names });
    startCompletion(by.view);
    await vi.waitFor(() => {
      expect(names.calls).toContain('labelNames null');
    });
  });

  const THROUGH: [string, string][] = [
    ['up{job="', 'labelValues job up'],
    ['up{job="",instance="', 'labelValues instance up{job=""}'],
    ['up{job!="",instance="', 'labelValues instance up{job!=""}'],
    ['up{job!="b",job="', 'labelValues job up{job!="b"}'],
    ['up{job=~"a.*",job="a', 'labelValues job up{job=~"a.*"}'],
    ['up{"service.name"="api",job="', 'labelValues job up{"service.name"="api"}'],
    ['up{job="a","service.name"="', 'labelValues service.name up{job="a"}'],
    ['{"my.metric",job="', 'labelValues job {__name__="my.metric"}'],
    [`up{a='x"y',job="`, `labelValues job up{a='x"y'}`],
    ['up{a=`x"y`,job="', 'labelValues job up{a=`x"y`}'],
    ['up{"a\\"b"="x",job="', 'labelValues job up{"a\\"b"="x"}'],
    ['up{job="a","a\\"b"="', 'labelValues a"b up{job="a"}'],
    [`up{'a"b'="x",job="`, `labelValues job up{'a"b'="x"}`],
    [`{'my.metric',job="`, `labelValues job {__name__='my.metric'}`],
  ];
  for (const [doc, call] of THROUGH) {
    it(`through the view: ${doc}`, async () => {
      expect(await lookupsAtEnd(doc)).toEqual([call]);
    });
  }
});

describe('unit:editor-doc', () => {
  it('programmatic replace and insert are single undoable events', () => {
    const onChange = vi.fn();
    const { view } = viewIn({ doc: 'upx', caret: 2, onChange });
    insertAtSelection(view, 'name');
    expect(view.state.doc.toString()).toBe('upnamex');
    expect(view.state.selection.main.head).toBe(6);
    expect(undoDepth(view.state)).toBe(1);
    expect(onChange).toHaveBeenLastCalledWith('upnamex');
    setDocument(view, 'rate(x[5m])');
    expect(view.state.selection.main.head).toBe(11);
    expect(undoDepth(view.state)).toBe(2);
    undo(view);
    expect(view.state.doc.toString()).toBe('upnamex');
    undo(view);
    expect(view.state.doc.toString()).toBe('upx');
    onChange.mockClear();
    setDocument(view, 'upx');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('unit:editor-diagnostics', () => {
  const list = (view: EditorView) => {
    const out: [number, number, string, string][] = [];
    forEachDiagnostic(view.state, (d, from, to) => {
      out.push([from, to, d.severity, d.message]);
    });
    return out;
  };
  it('shows run diagnostics as errors, clamped; [] clears', () => {
    const { view } = viewIn({ doc: 'up' });
    showDiagnostics(view, [{ from: 0, to: 2, message: 'bad', positionKnown: true }]);
    expect(list(view)).toEqual([[0, 2, 'error', 'bad']]);
    showDiagnostics(view, []);
    expect(list(view)).toEqual([]);
    showDiagnostics(view, [{ from: 5, to: 9, message: 'late', positionKnown: true }]);
    expect(list(view)).toEqual([[2, 2, 'error', 'late']]);
  });
});

describe('unit:editor-no-linter', () => {
  it('places no client-side diagnostic', async () => {
    const { view } = viewIn({ doc: '' });
    view.dispatch({ changes: { from: 0, insert: 'rate(up)' } });
    await wait(1000);
    expect(diagnosticCount(view.state)).toBe(0);
  });
});

describe('unit:editor-styles', () => {
  it('adopts stylesheets in the shadow root and adds no <style>', () => {
    const before = document.querySelectorAll('style').length;
    const { root } = viewIn({ doc: 'sum(rate(x{a="b"}[5m]))' });
    expect(root.adoptedStyleSheets.length).toBeGreaterThanOrEqual(1);
    expect(document.querySelectorAll('style').length).toBe(before);
    expect(root.querySelectorAll('style').length).toBe(0);
    const rules = promqlHighlight.module?.getRules() ?? '';
    for (const v of ['keyword', 'func', 'string', 'number', 'label']) {
      expect(rules).toContain(`var(--syn-${v})`);
    }
    expect(rules).not.toMatch(/#[0-9a-fA-F]/);
  });
});

describe('unit:editor-probe', () => {
  const g = globalThis as Record<string, unknown>;
  afterEach(() => {
    Reflect.deleteProperty(g, EDITOR_PROBE_GLOBAL);
  });

  it('times each update when the bench installs a probe before the view', () => {
    const probe = vi.fn<(ms: number, docChanged: boolean) => void>();
    g[EDITOR_PROBE_GLOBAL] = probe;
    const { view } = viewIn({ doc: 'up', caret: 2 });
    probe.mockClear(); // viewIn places the caret with its own dispatch
    insertAtSelection(view, 'x');
    expect(probe).toHaveBeenCalledTimes(1);
    const [ms, changed] = probe.mock.calls[0] ?? [];
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(changed).toBe(true);
    view.dispatch({ selection: { anchor: 0 } });
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe.mock.calls[1]?.[1]).toBe(false);
  });

  it('is read once per view: a probe set later is never called', () => {
    const { view } = viewIn({ doc: 'up', caret: 2 });
    const probe = vi.fn();
    g[EDITOR_PROBE_GLOBAL] = probe;
    insertAtSelection(view, 'x');
    expect(probe).not.toHaveBeenCalled();
  });
});
