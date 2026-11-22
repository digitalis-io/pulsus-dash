/**
 * The LogQL editor (plan #66 Part A §3.10; T09-004): `QueryEditorHost` with the LogQL extensions
 * and `LOGQL_COMPLETION` (both completion slots start in the keystroke's task; remote lookups wait
 * 120 ms in their own slot). The source is read at each lookup through a proxy that forwards the
 * caller's signal, so a new `source` takes effect at the next lookup.
 */
import { useCallback, useEffect, useRef, type JSX } from 'react';
import { LOGQL_COMPLETION } from './lang/logql/complete';
import { logqlExtensions } from './lang/logql/extensions';
import type { LogSource } from './lang/types';
import { QueryEditorHost, type QueryEditorBaseProps } from './QueryEditorHost';

export interface LogQLEditorProps extends QueryEditorBaseProps {
  /** Read at each lookup: a new source takes effect at once. */
  readonly source: LogSource;
}

export function LogQLEditor({ source, ...rest }: LogQLEditorProps): JSX.Element {
  const src = useRef(source);
  useEffect(() => {
    src.current = source;
  });
  const language = useCallback(() => {
    const proxy: LogSource = {
      labelNames: (selector, signal) => src.current.labelNames(selector, signal),
      labelValues: (name, selector, signal) => src.current.labelValues(name, selector, signal),
    };
    return logqlExtensions(proxy);
  }, []);
  return <QueryEditorHost {...rest} language={language} completion={LOGQL_COMPLETION} />;
}
