/**
 * A stand-in for the editor chunk in page tests (plan #63 Part C §3.5):
 * `vi.mock('../../editor/editor', () => import('../../test/fakeEditor'))`. `PromQLEditor` is a
 * `<textarea>` controlled from `value` the way the real host is: a changed `value` that differs
 * from the text replaces it and is reported through `onChange`, as the real view's update listener
 * does. Shift+Enter, Ctrl+Enter and Meta+Enter run, Escape leaves (and goes no further, as a key the
 * real view handles). The latest `diagnostics` are
 * written to `data-diagnostics` as JSON. `createPromSource` returns a `fakePromSource` of
 * `fakeEditorSource.data` (default `F`); `promql` is the real language module.
 */
import { useEffect, useImperativeHandle, useRef, type JSX, type KeyboardEvent } from 'react';
import type { PromQLEditorProps } from '../editor/PromQLEditor';
import type { PromSource } from '../editor/lang/types';
import { F, fakePromSource, type FakePromData } from './fakePromSource';

export { promql } from '../editor/lang/promql/promql';
export type { PromQLEditorHandle, PromQLEditorProps } from '../editor/PromQLEditor';

/** The data the next `createPromSource` serves; a test may replace it before rendering. */
export const fakeEditorSource: { data: FakePromData } = { data: F };

/** Called with `PromSourceDeps` like the real one; the fake reads none of them. */
export function createPromSource(): PromSource {
  return fakePromSource(fakeEditorSource.data);
}

export function PromQLEditor({ ref, className, ...p }: PromQLEditorProps): JSX.Element {
  const el = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(p);
  useEffect(() => {
    latest.current = p;
  });

  useEffect(() => {
    const t = el.current;
    if (t !== null && t.value !== p.value) {
      t.value = p.value;
      latest.current.onChange(p.value);
    }
  }, [p.value]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        el.current?.focus();
      },
      insert: (text) => {
        const t = el.current;
        if (t === null) return;
        const at = t.selectionStart;
        const end = t.selectionEnd;
        t.value = t.value.slice(0, at) + text + t.value.slice(end);
        t.selectionStart = t.selectionEnd = at + text.length;
        latest.current.onChange(t.value);
      },
    }),
    [],
  );

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      latest.current.onRun();
    } else if (e.key === 'Escape') {
      // Handled, as the real view's keymap does: it goes no further (plan #64, T09-004).
      e.preventDefault();
      e.stopPropagation();
      latest.current.onEscape();
    }
  };

  return (
    <div data-editor-host="" className={className}>
      <textarea
        ref={el}
        aria-label={p.label}
        placeholder={p.placeholder}
        defaultValue={p.value}
        data-diagnostics={JSON.stringify(p.diagnostics)}
        onChange={(e) => {
          latest.current.onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
