import { startCompletion } from '@codemirror/autocomplete';
import { diagnosticCount } from '@codemirror/lint';
import { EditorView } from '@codemirror/view';
import { act, render } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { F, fakePromSource } from '../test/fakePromSource';
import type { Diagnostic, PromSource } from './lang/types';
import { PromQLEditor, type PromQLEditorHandle } from './PromQLEditor';
import { setDocument } from './view';

describe('unit:editor-host', () => {
  it('one shadow root and view under StrictMode; follows its props; cleans up', async () => {
    const r = createRef<PromQLEditorHandle>();
    const first = fakePromSource(F);
    const el = (value: string, source: PromSource, diagnostics: readonly Diagnostic[]) => (
      <StrictMode>
        <PromQLEditor
          value={value}
          source={source}
          diagnostics={diagnostics}
          label="PromQL query"
          placeholder="p"
          onChange={vi.fn()}
          onRun={vi.fn()}
          onEscape={vi.fn()}
          ref={r}
        />
      </StrictMode>
    );
    const { container, rerender, unmount } = render(el('up', first, []));
    const outer = container.querySelector('[data-editor-host]');
    expect(outer).not.toBeNull();
    const inner = [...(outer?.children ?? [])].filter((e) => e.shadowRoot !== null);
    expect(inner).toHaveLength(1);
    const shadow = inner[0]?.shadowRoot;
    expect(shadow?.querySelectorAll('.cm-editor')).toHaveLength(1);
    const dom = shadow?.querySelector('.cm-editor');
    const view = dom instanceof HTMLElement ? EditorView.findFromDOM(dom) : null;
    if (view === null) throw new Error('no view');
    const content = shadow?.querySelector('.cm-content');
    expect(content?.getAttribute('aria-label')).toBe('PromQL query');
    expect(content?.getAttribute('role')).toBe('textbox');
    expect(view.state.doc.toString()).toBe('up');

    rerender(el('x', first, []));
    expect(view.state.doc.toString()).toBe('x');
    rerender(el('x', first, [{ from: 0, to: 1, message: 'm', positionKnown: true }]));
    expect(diagnosticCount(view.state)).toBe(1);
    act(() => {
      r.current?.insert('y');
    });
    expect(view.state.doc.toString()).toBe('xy');
    act(() => {
      r.current?.focus();
    });
    expect(view.hasFocus).toBe(true);

    const second = fakePromSource(F);
    rerender(el('xy', second, []));
    const before = first.calls.length;
    setDocument(view, 'htt');
    startCompletion(view);
    await vi.waitFor(() => {
      expect(second.calls).toContain('metricNames');
    });
    expect(first.calls.length).toBe(before);

    const host = inner[0];
    unmount();
    expect(host?.isConnected).toBe(false);
    expect(view.dom.isConnected).toBe(false);
  });
});
