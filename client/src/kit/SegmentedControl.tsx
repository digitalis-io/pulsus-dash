/** Stub (tests first, plan #63 Part C §3.4). */
import type { JSX } from 'react';

export interface SegmentedOption<K extends string> {
  readonly id: K;
  readonly label: string;
}
export interface SegmentedControlProps<K extends string> {
  readonly label: string;
  readonly options: readonly SegmentedOption<K>[];
  readonly value: K;
  readonly onChange: (v: K) => void;
}
export function SegmentedControl<K extends string>(_p: SegmentedControlProps<K>): JSX.Element {
  throw new Error('not implemented');
}
