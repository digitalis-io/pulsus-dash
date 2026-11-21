import type { EditorView } from '@codemirror/view';
import type { Diagnostic, PromSource } from './lang/types';

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
const ni = (): never => {
  throw new Error('not implemented');
};
export function createPromQLView(_o: PromQLViewOptions): EditorView {
  return ni();
}
export function setDocument(_view: EditorView, _text: string): void {
  ni();
}
export function insertAtSelection(_view: EditorView, _text: string): void {
  ni();
}
export function showDiagnostics(_view: EditorView, _d: readonly Diagnostic[]): void {
  ni();
}
