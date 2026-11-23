/**
 * The PromQL editor (plan #63 Part B §3.6; plan #66 Part A §3.10): `QueryEditorHost` with the
 * PromQL extensions and `PROMQL_COMPLETION` (plan #107). The source is read at each lookup through a
 * proxy that forwards the lookup's signal, so a new `source` takes effect at once.
 */
import { useCallback, useEffect, useRef, type JSX } from 'react';
import { PROMQL_COMPLETION } from './lang/promql/complete';
import { promqlExtensions } from './lang/promql/extensions';
import type { PromSource } from './lang/types';
import {
  QueryEditorHost,
  type QueryEditorBaseProps,
  type QueryEditorHandle,
} from './QueryEditorHost';

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
      metricNames: (s) => src.current.metricNames(s),
      labelNames: (m, s) => src.current.labelNames(m, s),
      labelValues: (n, m, s) => src.current.labelValues(n, m, s),
      series: (m, s) => src.current.series(m, s),
      metadata: () => src.current.metadata(),
    };
    return promqlExtensions(proxy);
  }, []);
  return <QueryEditorHost {...rest} language={language} completion={PROMQL_COMPLETION} />;
}
