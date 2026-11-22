/** The shared editor host (plan #66 Part A §3.10). Stub: not implemented yet. */
import type { Extension } from '@codemirror/state';
import type { JSX, Ref } from 'react';
import type { Diagnostic } from './lang/types';
import type { CompletionTiming } from './view';

export interface QueryEditorHandle {
  focus(): void;
  insert(text: string): void;
}

export interface QueryEditorBaseProps {
  readonly value: string;
  readonly onChange: (text: string) => void;
  readonly onRun: () => void;
  readonly onEscape: () => void;
  readonly diagnostics: readonly Diagnostic[];
  readonly label: string;
  readonly placeholder: string;
  readonly readOnly?: boolean;
  readonly className?: string;
  readonly ref?: Ref<QueryEditorHandle>;
}

export function QueryEditorHost(
  _p: QueryEditorBaseProps & {
    readonly language: () => Extension;
    readonly completion: CompletionTiming;
  },
): JSX.Element {
  throw new Error('not implemented');
}
