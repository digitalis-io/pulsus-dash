/**
 * The editor's update probe (plan #63 Part C C.11.2; T09-003): `bench:editor-keystroke` installs a
 * global function before the page loads, and each view then times every `view.update(trs)`. In
 * normal use there is no probe and CodeMirror's own dispatch runs unchanged.
 */
import type { EditorViewConfig } from '@codemirror/view';

/** Installed only by `bench:editor-keystroke` (before the page loads); absent in normal use. */
export type EditorProbe = (ms: number, docChanged: boolean) => void;
export const EDITOR_PROBE_GLOBAL = '__pulsusEditorProbe';

export function editorProbe(): EditorProbe | null {
  const p: unknown = (globalThis as Record<string, unknown>)[EDITOR_PROBE_GLOBAL];
  return typeof p === 'function' ? (p as EditorProbe) : null;
}

/** Read once per view. Without a probe: `{}`, so CodeMirror's own dispatch runs unchanged. */
export function probedDispatch(): Pick<EditorViewConfig, 'dispatchTransactions'> {
  const probe = editorProbe();
  if (probe === null) return {};
  return {
    dispatchTransactions: (trs, view) => {
      const t0 = performance.now();
      view.update(trs);
      probe(
        performance.now() - t0,
        trs.some((tr) => tr.docChanged),
      );
    },
  };
}

/** The bench's completion probe (plan #107 §3.9). */
export const COMPLETION_PROBE_GLOBAL = '__pulsusCompletionProbe';
export type CompletionProbe = (ms: number, part: 'slot0' | 'slot1pre' | 'slot1post') => void;

export function completionProbe(): CompletionProbe | null {
  throw new Error('not implemented');
}
