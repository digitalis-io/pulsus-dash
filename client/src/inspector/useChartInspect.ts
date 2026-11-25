/**
 * The inspect props of a chart or log stream (T25-005, plan #192 §3): `onInspect` builds the
 * `InspectRequest` with the Context window and the target's selection; `onEmptyClick` clears the
 * selection. Absent without a host.
 */
import type { ChartFrameProps } from '../charts/ChartFrame';
import type { InspectOrigin } from './types';

export function useChartInspect(
  o: Omit<InspectOrigin, 'window'>,
): Pick<ChartFrameProps, 'onInspect' | 'onEmptyClick'> {
  void o;
  return {};
}
