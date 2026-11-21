/**
 * The completion guard (plan #63 Part B §3.5, B.8 #13): while an IME composes (T09-005) or the
 * document is over 128 KB of UTF-8 (T09-015), no completion opens, is looked up or is accepted;
 * editing and highlighting go on. `compositionstart` closes an open popup (CodeMirror re-filters an
 * open list on every change, so closing is the only way it is not reordered or replaced); results
 * that arrive while composing are held and dropped; one re-evaluation follows the last
 * `compositionend`. Growing past the limit closes an open popup.
 */
import {
  closeCompletion,
  completionStatus,
  startCompletion,
  type CompletionSource,
} from '@codemirror/autocomplete';
import { StateField, type Extension, type Text } from '@codemirror/state';
import { ViewPlugin, type Command, type EditorView, type ViewUpdate } from '@codemirror/view';
import { overQueryLimit, QUERY_BYTE_LIMIT } from '../explore/querySize';

/** The wait after `compositionend`: CodeMirror flushes the composed text first. */
const REEVALUATE_MS = 20;

function overLimit(doc: Text): boolean {
  // The fast paths of overQueryLimit, without building the string when they decide.
  if (doc.length * 3 <= QUERY_BYTE_LIMIT) return false;
  if (doc.length > QUERY_BYTE_LIMIT) return true;
  return overQueryLimit(doc.toString());
}

/** True while the document is over `QUERY_BYTE_LIMIT` bytes of UTF-8; measured on every change. */
export const overLimitField: StateField<boolean> = StateField.define<boolean>({
  create: (state) => overLimit(state.doc),
  update: (value, tr) => (tr.docChanged ? overLimit(tr.newDoc) : value),
});

export interface CompletionGuard {
  /** `overLimitField` and the guard's view plugin. */
  readonly extension: Extension;
  /** The guarded source. */
  source(inner: CompletionSource): CompletionSource;
  /** `cmd` unless blocked; blocked, it is not run and returns false. */
  whenFree(cmd: Command): Command;
}

/** One per view: the plugin binds it to its view. */
export function completionGuard(): CompletionGuard {
  let composing = false;
  /** The document changed during the current composition. */
  let changed = false;
  /** `compositionstart` closed a popup. */
  let closed = false;
  const held: ((v: null) => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Incremented by every `compositionstart`: a re-evaluation runs only for the last one. */
  let gen = 0;
  let bound: EditorView | null = null;

  const isComposing = (v: EditorView) => composing || v.composing;
  const isOver = (v: EditorView) => v.state.field(overLimitField, false) === true;
  const blocked = (v: EditorView) => isComposing(v) || isOver(v);

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  /** Resolves every held result `null`; true if there was one. */
  const releaseHeld = (): boolean => {
    const any = held.length > 0;
    for (const r of held.splice(0)) r(null);
    return any;
  };

  const plugin = ViewPlugin.define(
    (view) => {
      bound = view;
      return {
        update(u: ViewUpdate) {
          if (composing && u.docChanged) changed = true;
          // Typing while composing starts CodeMirror's own pending query: nothing opens.
          if (composing && completionStatus(u.state) !== null) {
            queueMicrotask(() => {
              if (bound === u.view && composing) closeCompletion(u.view);
            });
          }
          const was = u.startState.field(overLimitField, false) === true;
          if (!was && isOver(u.view) && completionStatus(u.state) !== null) {
            queueMicrotask(() => {
              if (bound === u.view) closeCompletion(u.view);
            });
          }
        },
        destroy() {
          releaseHeld();
          stopTimer();
          bound = null;
        },
      };
    },
    {
      eventObservers: {
        compositionstart(_e, view) {
          composing = true;
          changed = false;
          closed = false;
          stopTimer();
          gen += 1;
          if (completionStatus(view.state) !== null) {
            closeCompletion(view);
            closed = true;
          }
        },
        compositionend(_e, view) {
          composing = false;
          const wasHeld = releaseHeld();
          stopTimer();
          const g = gen;
          timer = setTimeout(() => {
            timer = null;
            if (g !== gen || composing || bound !== view) return;
            if (!blocked(view) && (changed || closed || wasHeld)) startCompletion(view);
          }, REEVALUATE_MS);
        },
      },
    },
  );

  return {
    extension: [overLimitField, plugin],
    source: (inner) => (ctx) => {
      const view = ctx.view ?? bound;
      const over = () => (view !== null ? isOver(view) : ctx.state.field(overLimitField, false));
      if (over() || (view !== null && isComposing(view))) return null;
      const r = inner(ctx);
      if (!(r instanceof Promise)) return r;
      return r.then((result) => {
        if (view !== null && isComposing(view)) {
          return new Promise<null>((resolve) => {
            held.push(resolve);
          });
        }
        return over() === true ? null : result;
      });
    },
    whenFree: (cmd) => (v) => (blocked(v) ? false : cmd(v)),
  };
}
