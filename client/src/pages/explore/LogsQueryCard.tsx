/** The Query card of Explore › Logs (plan #66 Part C §3.9). */
import type { JSX, ReactNode, Ref } from 'react';
import type { Diagnostic, LogSource } from '../../editor/lang/types';
import type { QueryEditorHandle } from '../../editor/QueryEditorHost';
import type { LogqlModules } from '../../explore/useLogqlModules';

export interface LogsQueryCardProps {
  readonly modules: LogqlModules;
  readonly q: string;
  /** Null until the editor chunk has loaded. */
  readonly source: LogSource | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly onDraft: (text: string) => void;
  readonly onRun: () => void;
  readonly onEscape: () => void;
  readonly status: ReactNode;
  readonly runReady: boolean;
  readonly editorRef: Ref<QueryEditorHandle>;
  readonly runButtonRef: Ref<HTMLButtonElement>;
}

export function LogsQueryCard(_p: LogsQueryCardProps): JSX.Element {
  throw new Error('not implemented');
}
