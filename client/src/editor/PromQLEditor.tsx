/**
 * The React host of the PromQL editor (plan #63 Part B §3.6, §4.4): the PromQL-only M-UI1
 * `QueryEditor`. React owns an empty outer `<div data-editor-host>`. The mount effect creates an
 * inner host with an open shadow root and the view in it, so style modules are adopted
 * stylesheets that `style-src 'self'` allows (ADR-0014 §9); StrictMode's second run attaches to a
 * new element. Props are read through a ref, so a new `source` or callback takes effect at once.
 */
import type { EditorView } from '@codemirror/view';
import { useEffect, useImperativeHandle, useRef, type JSX, type Ref } from 'react';
import type { Diagnostic, PromSource } from './lang/types';
import { createPromQLView, insertAtSelection, setDocument, showDiagnostics } from './view';

export interface PromQLEditorHandle {
  /** No-op before mount. */
  focus(): void;
  /** Replaces the selection with `text` (no-op before mount). */
  insert(text: string): void;
}

export interface PromQLEditorProps {
  /** When it changes and differs from the document, it replaces it. */
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** Shift+Enter, Mod+Enter. */
  readonly onRun: () => void;
  /** Escape with no completion popup open. */
  readonly onEscape: () => void;
  /** Read at each lookup: a new source takes effect at once. */
  readonly source: PromSource;
  /** Shown on change of identity. */
  readonly diagnostics: readonly Diagnostic[];
  /** Read at mount. */
  readonly label: string;
  /** Read at mount. */
  readonly placeholder: string;
  /** On the outer `<div data-editor-host>`. */
  readonly className?: string;
  readonly ref?: Ref<PromQLEditorHandle>;
}

export function PromQLEditor({ ref, className, ...p }: PromQLEditorProps): JSX.Element {
  const outer = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(p);
  useEffect(() => {
    latest.current = p;
  });

  useEffect(() => {
    const el = outer.current;
    if (el === null) return;
    const inner = document.createElement('div');
    // A tab stop that delegates into the shadow root: a focus-containing dialog (the board panel
    // editor, plan #64) walks the light DOM for tabbable elements and would otherwise skip the view.
    inner.tabIndex = 0;
    el.append(inner);
    const root = inner.attachShadow({ mode: 'open', delegatesFocus: true });
    const mount = document.createElement('div');
    root.append(mount);
    const source: PromSource = {
      metricNames: () => latest.current.source.metricNames(),
      labelNames: (m) => latest.current.source.labelNames(m),
      labelValues: (n, m) => latest.current.source.labelValues(n, m),
      series: (m) => latest.current.source.series(m),
      metadata: () => latest.current.source.metadata(),
    };
    const v = createPromQLView({
      parent: mount,
      root,
      doc: latest.current.value,
      label: latest.current.label,
      placeholder: latest.current.placeholder,
      source,
      onChange: (text) => {
        latest.current.onChange(text);
      },
      onRun: () => {
        latest.current.onRun();
      },
      onEscape: () => {
        latest.current.onEscape();
      },
    });
    view.current = v;
    // Focus delegated to the host lands on the view's first focusable element, its scroller
    // (`tabindex="-1"`): move it on to the text.
    const onFocusIn = (e: Event): void => {
      if (e.target === v.scrollDOM) v.focus();
    };
    root.addEventListener('focusin', onFocusIn);
    return () => {
      root.removeEventListener('focusin', onFocusIn);
      view.current = null;
      v.destroy();
      inner.remove();
    };
  }, []);

  useEffect(() => {
    const v = view.current;
    if (v !== null && v.state.doc.toString() !== p.value) setDocument(v, p.value);
  }, [p.value]);

  useEffect(() => {
    const v = view.current;
    if (v !== null) showDiagnostics(v, p.diagnostics);
  }, [p.diagnostics]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => {
        view.current?.focus();
      },
      insert: (text) => {
        const v = view.current;
        if (v !== null) insertAtSelection(v, text);
      },
    }),
    [],
  );

  return <div ref={outer} data-editor-host="" className={className} />;
}
