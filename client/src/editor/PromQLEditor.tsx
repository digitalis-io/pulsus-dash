/**
 * The PromQL editor (plan #63 Part B §3.6; plan #66 Part A §3.10): `QueryEditorHost` with the
 * PromQL extensions and `PROMQL_COMPLETION`. The source is read at each lookup through a proxy, so
 * a new `source` takes effect at once.
 */
import { useCallback, useEffect, useRef, type JSX } from 'react';
import { promqlExtensions } from './lang/promql/extensions';
import type { PromSource } from './lang/types';
import {
  QueryEditorHost,
  type QueryEditorBaseProps,
  type QueryEditorHandle,
} from './QueryEditorHost';
import { PROMQL_COMPLETION } from './view';

export type PromQLEditorHandle = QueryEditorHandle;

export interface PromQLEditorProps extends QueryEditorBaseProps {
  /** Read at each lookup: a new source takes effect at once. */
  readonly source: PromSource;
}

export function PromQLEditor({ source, ...rest }: PromQLEditorProps): JSX.Element {
  const src = useRef(source);
  useEffect(() => {
    src.current = source;
  });
  const language = useCallback(() => {
    const proxy: PromSource = {
      metricNames: () => src.current.metricNames(),
      labelNames: (m) => src.current.labelNames(m),
      labelValues: (n, m) => src.current.labelValues(n, m),
      series: (m) => src.current.series(m),
      metadata: () => src.current.metadata(),
    };
    return promqlExtensions(proxy);
  }, []);
  return <QueryEditorHost {...rest} language={language} completion={PROMQL_COMPLETION} />;
}
