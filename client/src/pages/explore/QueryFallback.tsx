/**
 * The plain text area a query field shows when the editor chunk fails to load (#147, #67; T09-004,
 * T08 §4.8): Shift+Enter, Ctrl+Enter or Meta+Enter run it, unchanged text included. It keeps its
 * own text; a changed `value` replaces it, as the editor host does. A degraded fallback, not an
 * editor surface: no completion, highlighting or diagnostics.
 */
import { useState, type JSX } from 'react';
import { TextArea } from '../../kit/TextArea';

export interface QueryFallbackProps {
  /** Seeds the text; a new value (by `!==`) replaces it. */
  readonly value: string;
  readonly label: string;
  /** Default false. */
  readonly readOnly?: boolean;
  readonly onChange: (text: string) => void;
  /** No argument, as the editor's `onRun`. */
  readonly onRun: () => void;
}

export function QueryFallback(p: QueryFallbackProps): JSX.Element {
  const [text, setText] = useState(p.value);
  const [seed, setSeed] = useState(p.value);
  // Adjusted while rendering: a new `value` replaces the text.
  if (p.value !== seed) {
    setSeed(p.value);
    setText(p.value);
  }
  return (
    <TextArea
      label={p.label}
      value={text}
      onChange={(v) => {
        setText(v);
        p.onChange(v);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          p.onRun();
        } else {
          e.continuePropagation();
        }
      }}
      isReadOnly={p.readOnly ?? false}
      mono
      rows={5}
      spellCheck="false"
      autoComplete="off"
    />
  );
}
