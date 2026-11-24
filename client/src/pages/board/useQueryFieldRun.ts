/**
 * The run rules of the panel editor's Query field (plan #64 §3.8, A.10; plan #67 §2), shared by
 * the PromQL and LogQL fields: the text goes to the draft on every change; it runs (the preview and
 * the panel behind) on Run query, Shift+Enter or Mod+Enter, and when focus leaves the field with a
 * text that has not run. An Escape the editor handled (T09-004) does not reach the dialog.
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';

export interface QueryFieldRunInput {
  readonly value: string;
  /** The text the preview and the panel run now (§4.4). */
  readonly runText: string;
  readonly readOnly: boolean;
  readonly onChange: (text: string) => void;
  readonly onRun: (text: string) => void;
}

/**
 * `keep`: a selector of elements outside the field that focus may move to without a run (the
 * metric picker's list).
 */
export function useQueryFieldRun(p: QueryFieldRunInput, keep?: string) {
  const { onChange, onRun } = p;
  // The latest text, for the editor's Run keys (they carry no text) and the blur rule.
  const valueRef = useRef(p.value);
  const runTextRef = useRef(p.runText);
  const onRunRef = useRef(onRun);
  // While the board saves or discards nothing is edited or run (review r1 #2).
  const readOnlyRef = useRef(p.readOnly);
  useLayoutEffect(() => {
    valueRef.current = p.value;
    runTextRef.current = p.runText;
    onRunRef.current = onRun;
    readOnlyRef.current = p.readOnly;
  });
  const runButtonRef = useRef<HTMLButtonElement>(null);
  const fieldRef = useRef<HTMLDivElement>(null);

  const onDraft = useCallback(
    (text: string) => {
      valueRef.current = text;
      onChange(text);
    },
    [onChange],
  );
  // The Run keys come from the editor's own (native) key handler: render the run in this task, so
  // the preview shows it in the next frame (#90 AC2), as the Run button's press does.
  const run = useCallback(() => {
    if (readOnlyRef.current) return;
    flushSync(() => {
      onRun(valueRef.current);
    });
  }, [onRun]);
  const onEscape = useCallback(() => {
    runButtonRef.current?.focus();
  }, []);
  // Focus leaving the field (not to its own controls or `keep`) runs a text not yet run.
  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    const onFocusOut = (e: FocusEvent): void => {
      const next = e.relatedTarget;
      if (next instanceof Node && field.contains(next)) return;
      if (keep !== undefined && next instanceof Element && next.closest(keep) !== null) return;
      if (readOnlyRef.current) return;
      if (valueRef.current !== runTextRef.current) onRunRef.current(valueRef.current);
    };
    // Escape the editor handled (T09-004: it closed the completion popup, or moved to Run query)
    // must not also reach the dialog, which closes on Escape. The editor's key handlers are its
    // own (native, inside the host), so they have run when the event bubbles here.
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('[data-editor-host]') !== null) {
        e.stopPropagation();
      }
    };
    field.addEventListener('focusout', onFocusOut);
    field.addEventListener('keydown', onKeyDown);
    return () => {
      field.removeEventListener('focusout', onFocusOut);
      field.removeEventListener('keydown', onKeyDown);
    };
  }, [keep]);
  return { fieldRef, runButtonRef, onDraft, run, onEscape };
}
