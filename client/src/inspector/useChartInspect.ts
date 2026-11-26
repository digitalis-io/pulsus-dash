/**
 * The inspect props of a chart or a log stream (T25-005, plan #192 §3): `onInspect` builds the
 * `InspectRequest` from the origin, the Context window at the moment of the gesture and the
 * target's selection; `onEmptyClick` clears the selection. Both are absent without a host, and both
 * are stable while the origin's fields are, so memoised panels do not render again.
 */
import { useLayoutEffect, useMemo, useRef } from 'react';
import { selectionOf } from '../charts/inspectTarget';
import type { ChartFrameProps } from '../charts/ChartFrame';
import { useTimeContext } from '../state/useTimeContext';
import { useInspector } from './host';
import type { InspectOrigin, Selection, SelectionSource } from './types';

export function useChartInspect(o: Omit<InspectOrigin, 'window'>): Pick<
  ChartFrameProps,
  'onInspect' | 'onEmptyClick'
> & {
  readonly onSelect?: (s: Selection | null, kind: SelectionSource['kind']) => void;
} {
  const api = useInspector();
  const { window: win } = useTimeContext();
  const latest = useRef({ o, win });
  useLayoutEffect(() => {
    latest.current = { o, win };
  });
  const panelId = o.panelId;
  return useMemo(() => {
    if (api === null) return {};
    return {
      onInspect: (target, source, returnFocus) => {
        const { o: origin, win: w } = latest.current;
        api.inspect({
          origin: { ...origin, window: { fromMs: w.fromMs, toMs: w.toMs } },
          target,
          selection: selectionOf(target),
          source,
          returnFocus,
        });
      },
      onEmptyClick: () => {
        api.select(null, { kind: 'mark', panelId });
      },
    };
  }, [api, panelId]);
}
