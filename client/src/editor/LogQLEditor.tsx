/** The LogQL editor (plan #66 Part A §3.10). Stub: not implemented yet. */
import type { JSX } from 'react';
import type { LogSource } from './lang/types';
import type { QueryEditorBaseProps } from './QueryEditorHost';

export interface LogQLEditorProps extends QueryEditorBaseProps {
  readonly source: LogSource;
}

export function LogQLEditor(_p: LogQLEditorProps): JSX.Element {
  throw new Error('not implemented');
}
