import { completionStatus, currentCompletions, startCompletion } from '@codemirror/autocomplete';
import { toggleComment } from '@codemirror/commands';
import { diagnosticCount, forEachDiagnostic } from '@codemirror/lint';
import { EditorView, runScopeHandlers } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { StrictMode, type JSX } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../test/editorDom';
import { StubApi } from '../api/StubApi';
import { ApiError } from '../api/types';
import { FL, fakeLogSource } from '../test/fakeLogSource';
import { F, fakePromSource } from '../test/fakePromSource';
import { flush, key, wait } from '../test/viewIn';
import type { Diagnostic, LogSource } from './lang/types';
import { STAGES } from './lang/logql/grammar';
import { logql } from './lang/logql/logql';
import { LogQLEditor } from './LogQLEditor';
import { PromQLEditor } from './PromQLEditor';
import { setDocument } from './view';

/** The one view under `container`'s editor host. */
function viewOf(container: HTMLElement): { view: EditorView; inner: Element; root: ShadowRoot } {
  const outer = container.querySelector('[data-editor-host]');
  const inner = [...(outer?.children ?? [])].filter((e) => e.shadowRoot !== null);
  expect(inner).toHaveLength(1);
  const el = inner[0];
  const root = el?.shadowRoot;
  if (el === undefined || root === null || root === undefined) throw new Error('no shadow root');
  expect(root.querySelectorAll('.cm-editor')).toHaveLength(1);
  const dom = root.querySelector('.cm-editor');
  const view = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null;
  if (view === null) throw new Error('no view');
  return { view, inner: el, root };
}

interface Props {
  readonly value: string;
  readonly source: LogSource;
  readonly diagnostics?: readonly Diagnostic[];
  readonly readOnly?: boolean;
  readonly onRun?: () => void;
  readonly onEscape?: () => void;
}

const logEditor = (p: Props): JSX.Element => (
  <StrictMode>
    <LogQLEditor
      value={p.value}
      source={p.source}
      diagnostics={p.diagnostics ?? []}
      label="LogQL query"
      placeholder=""
      onChange={vi.fn()}
      onRun={p.onRun ?? vi.fn()}
      onEscape={p.onEscape ?? vi.fn()}
      {...(p.readOnly === undefined ? {} : { readOnly: p.readOnly })}
    />
  </StrictMode>
);

const press = (view: EditorView, init: KeyboardEventInit) =>
  runScopeHandlers(view, key(init), 'editor');

describe('unit:logql-editor', () => {
  it('the LogQL editor on the shared host', async () => {
    const onRun = vi.fn();
    const onEscape = vi.fn();
    const first = fakeLogSource(FL);
    const p: Props = { value: '{a="b"}', source: first, onRun, onEscape };
    // jsdom has no `ShadowRoot.delegatesFocus`: the host's request is read from the call.
    const attach = vi.spyOn(Element.prototype, 'attachShadow');
    const { container, rerender, unmount } = render(logEditor(p));
    const { view, inner, root } = viewOf(container);
    expect((inner as HTMLElement).tabIndex).toBe(0);
    expect(attach.mock.calls.at(-1)?.[0]).toEqual({ mode: 'open', delegatesFocus: true });
    attach.mockRestore();
    const content = root.querySelector('.cm-content');
    expect(content?.getAttribute('aria-label')).toBe('LogQL query');
    expect(content?.getAttribute('role')).toBe('textbox');
    expect(view.state.doc.toString()).toBe('{a="b"}');

    expect(press(view, { key: 'Enter', shiftKey: true })).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(press(view, { key: 'Enter', ctrlKey: true })).toBe(true);
    expect(onRun).toHaveBeenCalledTimes(2);
    expect(press(view, { key: 'Escape' })).toBe(true);
    expect(onEscape).toHaveBeenCalledTimes(1);

    rerender(
      logEditor({ ...p, diagnostics: [{ from: 0, to: 1, message: 'm', positionKnown: true }] }),
    );
    expect(diagnosticCount(view.state)).toBe(1);

    setDocument(view, '{app="');
    startCompletion(view);
    await flush();
    await vi.waitFor(() => {
      expect(completionStatus(view.state)).toBe('active');
    });
    expect(currentCompletions(view.state).map((c) => c.label)).toEqual(['checkout', 'web']);
    expect(first.calls).toEqual(['labelValues app null']);
    await wait(80); // CodeMirror's 75 ms interaction delay
    expect(press(view, { key: 'Tab' })).toBe(true);
    expect(view.state.doc.toString()).toBe('{app="checkout"');
    expect(view.state.selection.main.head).toBe(15);

    const second = fakeLogSource(FL);
    rerender(logEditor({ ...p, value: '{app="checkout"', source: second }));
    setDocument(view, '{pod="');
    startCompletion(view);
    await vi.waitFor(() => {
      expect(second.calls).toEqual(['labelValues pod null']);
    });
    expect(first.calls).toEqual(['labelValues app null']);

    rerender(logEditor({ ...p, value: '{pod="', source: second, readOnly: true }));
    expect(content?.getAttribute('aria-readonly')).toBe('true');
    expect(view.state.readOnly).toBe(true);
    rerender(logEditor({ ...p, value: '{pod="', source: second, readOnly: false }));

    const before = second.calls.length;
    act(() => {
      view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    startCompletion(view);
    await wait(100);
    expect(second.calls).toHaveLength(before);

    unmount();
    expect(inner.isConnected).toBe(false);
  });
  it('a positioned server refusal of a `#` underlines the `#`, which is not a comment (#121)', async () => {
    // PulsusDB's LogQL has no comments: the planner refuses a top-level `#` at its byte offset.
    const text = '{app="é"} # note';
    let refusal: unknown = null;
    try {
      await new StubApi().queryLogs('demo', {
        query: text,
        fromMs: 1767225600000,
        toMs: 1767229200000,
        widthPx: 1200,
      });
    } catch (e) {
      refusal = e;
    }
    expect(refusal).toBeInstanceOf(ApiError);
    expect((refusal as ApiError).detail.position).toBe(11);
    const diagnostics = logql.diagnosticsOf(text, refusal, (i) => i, text);
    const hash = text.indexOf('#');
    expect(diagnostics).toEqual([
      {
        from: hash,
        to: hash + 1,
        message: "unexpected '#' at byte 11: LogQL has no comments",
        positionKnown: true,
      },
    ]);
    const { container } = render(
      logEditor({ value: text, source: fakeLogSource(FL), diagnostics }),
    );
    const { view } = viewOf(container);
    const shown: [number, number][] = [];
    forEachDiagnostic(view.state, (d, from, to) => {
      shown.push([from, to]);
      expect(d.severity).toBe('error');
    });
    expect(shown).toEqual([[hash, hash + 1]]);
    // No line-comment token and no comment command: toggling leaves the text as it is.
    expect(view.state.languageDataAt('commentTokens', 0)).toEqual([]);
    expect(toggleComment(view)).toBe(false);
    expect(view.state.doc.toString()).toBe(text);
  });
});

describe('unit:logql-completion-timing', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** One typed character at the caret, as CodeMirror's input handler dispatches it. */
  const type = (view: EditorView, ch: string) => {
    const at = view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, insert: ch },
      selection: { anchor: at + ch.length },
      userEvent: 'input.type',
    });
  };

  /** A LogQL editor on `marked` (caret at `‸`). */
  function mount(marked: string, source = fakeLogSource(FL)) {
    const pos = marked.indexOf('‸');
    const value = marked.replace('‸', '');
    const { container } = render(logEditor({ value, source }));
    const { view } = viewOf(container);
    view.dispatch({ selection: { anchor: pos } });
    return { view, source };
  }

  it('T1: a stage list opens in the keystroke task, with no lookup', async () => {
    const { view, source } = mount('{app="web"} ‸');
    type(view, '|');
    await vi.advanceTimersByTimeAsync(1);
    expect(completionStatus(view.state)).toBe('active');
    expect(
      currentCompletions(view.state)
        .map((c) => c.label)
        .sort(),
    ).toEqual([...STAGES].sort());
    expect(source.calls).toEqual([]);
  });

  it('T2: a lookup starts 120 ms after the keystroke', async () => {
    const { view, source } = mount('{app="‸"}');
    type(view, 'w');
    await vi.advanceTimersByTimeAsync(119);
    expect(source.calls).toEqual([]);
    expect(completionStatus(view.state)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.calls).toEqual(['labelValues app null']);
    expect(currentCompletions(view.state).map((c) => c.label)).toEqual(['web']);
  });

  it('T3: every keystroke restarts the wait', async () => {
    const { view, source } = mount('{app="‸"}');
    type(view, 'w');
    await vi.advanceTimersByTimeAsync(60);
    type(view, 'e');
    await vi.advanceTimersByTimeAsync(119);
    expect(source.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(source.calls).toHaveLength(1);
  });

  it('T4: an explicit start looks up at once', async () => {
    const { view, source } = mount('{app="‸"}');
    startCompletion(view);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(0);
    expect(source.calls).toHaveLength(1);
  });

  it('T5: PromQL keeps its 120 ms typing delay', async () => {
    const source = fakePromSource(F);
    const { container } = render(
      <PromQLEditor
        value=""
        source={source}
        diagnostics={[]}
        label="PromQL query"
        placeholder=""
        onChange={vi.fn()}
        onRun={vi.fn()}
        onEscape={vi.fn()}
      />,
    );
    const { view } = viewOf(container);
    type(view, 'u');
    await vi.advanceTimersByTimeAsync(119);
    expect(source.calls).toEqual([]);
  });
});
