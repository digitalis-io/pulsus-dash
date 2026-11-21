/** Stub (tests first, plan #63 Part C §3.3). */
import type { JSX } from 'react';
import type { PromMetadata } from '../../data/decode';

export interface MetricPickerProps {
  readonly tenant: string;
  readonly names: (() => Promise<readonly string[]>) | null;
  readonly meta: PromMetadata['metrics'];
  readonly onPick: (name: string) => void;
}
export function MetricPicker(_p: MetricPickerProps): JSX.Element {
  throw new Error('not implemented');
}
