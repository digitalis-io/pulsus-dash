/** Stub (tests first, plan #63 Part C C.11.2). */
import type { EditorViewConfig } from '@codemirror/view';

export type EditorProbe = (ms: number, docChanged: boolean) => void;
export const EDITOR_PROBE_GLOBAL = '__pulsusEditorProbe';

export function editorProbe(): EditorProbe | null {
  return null;
}

export function probedDispatch(): Pick<EditorViewConfig, 'dispatchTransactions'> {
  return {};
}
