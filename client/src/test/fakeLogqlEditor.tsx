/**
 * A stand-in for the LogQL editor chunk in page tests (plan #66 Part C §5.2):
 * `vi.mock('../../editor/logqlEditor', () => import('../../test/fakeLogqlEditor'))`. `LogQLEditor`
 * is a labelled `<textarea>` controlled from `value` the way the real host is (a changed `value`
 * that differs from the text replaces it and is reported through `onChange`). Shift+Enter,
 * Ctrl+Enter and Meta+Enter run; Escape leaves. The latest `diagnostics` are written to
 * `data-diagnostics` as JSON. `createLogSource` returns a `fakeLogSource` of
 * `fakeLogqlEditorSource.data`; `logql` is the real language module.
 */
import { useEffect, useImperativeHandle, useRef, type JSX, type KeyboardEvent } from 'react';
import type { LogQLEditorProps } from '../editor/LogQLEditor';
import type { LogSource } from '../editor/lang/types';
import { fakeLogSource, type FakeLogData } from './fakeLogSource';

export { logql } from '../editor/lang/logql/logql';
export type { LogQLEditorProps } from '../editor/LogQLEditor';
export type { QueryEditorHandle } from '../editor/QueryEditorHost';

/** The data the next `createLogSource` serves; a test may replace it before rendering. */
export const fakeLogqlEditorSource: { data: FakeLogData } = { data: {} };

/** Called with `LanguageDeps` like the real one; the fake reads none of them. */
export function createLogSource(): LogSource {
  return fakeLogSource(fakeLogqlEditorSource.data);
}

export function LogQLEditor({ ref, className, ...p }: LogQLEditorProps): JSX.Element {
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
        t.value = t.value.slice(0, at) + text + t.value.slice(t.selectionEnd);
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
        readOnly={p.readOnly === true}
        data-diagnostics={JSON.stringify(p.diagnostics)}
        onChange={(e) => {
          latest.current.onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
