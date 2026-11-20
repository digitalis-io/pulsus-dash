import type { FrameData, VisSpec } from '../engine/api';

export interface ChartFrameProps {
  readonly spec: VisSpec;
  readonly data: FrameData;
}

export function ChartFrame(_p: ChartFrameProps): React.JSX.Element {
  throw new Error('not implemented');
}
