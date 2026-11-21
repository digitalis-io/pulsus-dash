import type { JSX, Ref } from 'react';
import type { Diagnostic, PromSource } from './lang/types';

export interface PromQLEditorHandle {
  focus(): void;
  insert(text: string): void;
}
export interface PromQLEditorProps {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onRun: () => void;
  readonly onEscape: () => void;
  readonly source: PromSource;
  readonly diagnostics: readonly Diagnostic[];
  readonly label: string;
  readonly placeholder: string;
  readonly className?: string;
  readonly ref?: Ref<PromQLEditorHandle>;
}
export function PromQLEditor(_p: PromQLEditorProps): JSX.Element {
  return <div data-editor-host="" />;
}
