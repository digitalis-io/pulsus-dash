/**
 * The PromQL editor view (plan #63 Part B §3.5): CodeMirror 6 in the host's shadow root, the
 * PromQL language extensions (`lang/promql`), the keymap of T09-004, one history for typing and
 * programmatic edits (T09-006), and every completion through the guard (T09-005, T09-015).
 */
import {
  acceptCompletion,
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  CompletionContext,
  completionKeymap,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, isolateHistory } from '@codemirror/commands';
import { bracketMatching, forceParsing, syntaxTree } from '@codemirror/language';
import { setDiagnostics } from '@codemirror/lint';
import { EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { completionGuard } from './completionGuard';
import { probedDispatch } from './probe';
import { promqlExtensions } from './lang/promql/extensions';
import type { Diagnostic, PromSource } from './lang/types';
import { promqlTheme } from './theme';

export interface PromQLViewOptions {
  readonly parent: HTMLElement;
  readonly root: ShadowRoot;
  readonly doc: string;
  readonly label: string;
  readonly placeholder: string;
  readonly source: PromSource;
  readonly onChange: (text: string) => void;
  readonly onRun: () => void;
  readonly onEscape: () => void;
}

/**
 * The most a completion request waits for the parser to reach the caret. Only a long document
 * (well past 1 KB) is not parsed that far when the request runs.
 */
const PARSE_BUDGET_MS = 100;

/**
 * The language's own completion source: its `autocomplete` language data at the caret. The
 * context is read from the syntax tree, so a tree that stops before the caret is parsed on first,
 * within `PARSE_BUDGET_MS`, and the request reads the state that holds it.
 */
const languageCompletion: CompletionSource = (c) => {
  let ctx = c;
  if (c.view !== undefined && syntaxTree(c.state).length < c.pos) {
    if (forceParsing(c.view, c.pos, PARSE_BUDGET_MS) && c.view.state.doc.eq(c.state.doc)) {
      ctx = new CompletionContext(c.view.state, c.pos, c.explicit, c.view);
    }
  }
  const source = ctx.state.languageDataAt<CompletionSource>('autocomplete', ctx.pos)[0];
  return source === undefined ? null : source(ctx);
};

export function createPromQLView(o: PromQLViewOptions): EditorView {
  const g = completionGuard();
  const run = () => {
    o.onRun();
    return true;
  };
  const escape = () => {
    o.onEscape();
    return true;
  };
  const state = EditorState.create({
    doc: o.doc,
    extensions: [
      history(),
      autocompletion({
        activateOnTypingDelay: 120,
        maxRenderedOptions: 100,
        icons: false,
        defaultKeymap: false,
        override: [g.source(languageCompletion)],
      }),
      // The default completion keys with a guarded Enter; above the run keys, so Escape closes
      // the popup first.
      Prec.highest(
        keymap.of(
          completionKeymap.map((b) =>
            b.run === acceptCompletion ? { ...b, run: g.whenFree(acceptCompletion) } : b,
          ),
        ),
      ),
      // Above defaultKeymap's Mod-Enter. Tab accepts only with the popup open; otherwise it is not
      // handled and focus moves on (T09-004).
      Prec.highest(
        keymap.of([
          { key: 'Shift-Enter', run },
          { key: 'Mod-Enter', run },
          { key: 'Escape', run: escape },
          { key: 'Tab', run: g.whenFree(acceptCompletion) },
        ]),
      ),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
      closeBrackets(),
      bracketMatching(),
      promqlExtensions(o.source),
      promqlTheme,
      placeholder(o.placeholder),
      EditorView.contentAttributes.of({ 'aria-label': o.label }),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) o.onChange(u.state.doc.toString());
      }),
      g.extension,
    ],
  });
  return new EditorView({ parent: o.parent, root: o.root, state, ...probedDispatch() });
}

/** Replaces the document (no-op when equal); caret at the end; its own undo event. */
export function setDocument(view: EditorView, text: string): void {
  if (view.state.doc.toString() === text) return;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: text.length },
    userEvent: 'input.set',
    annotations: isolateHistory.of('full'),
  });
}

/** Replaces the selection with `text`, caret after it; its own undo event. */
export function insertAtSelection(view: EditorView, text: string): void {
  view.dispatch(view.state.replaceSelection(text), {
    userEvent: 'input.complete',
    annotations: isolateHistory.of('full'),
    scrollIntoView: true,
  });
}

/** Shows run diagnostics as errors, clamped to the document; `[]` clears. */
export function showDiagnostics(view: EditorView, d: readonly Diagnostic[]): void {
  const len = view.state.doc.length;
  const clamp = (n: number) => Math.min(Math.max(n, 0), len);
  view.dispatch(
    setDiagnostics(
      view.state,
      d.map((x) => {
        const from = clamp(x.from);
        return { from, to: Math.max(from, clamp(x.to)), severity: 'error', message: x.message };
      }),
    ),
  );
}
