/** Stub (tests first, plan #63 Part C §3.3). */
import type { JSX } from 'react';
import type { Completeness } from '../../data/decode';

export interface CompletenessNoticeProps {
  readonly completeness: Completeness;
  readonly onNarrow: () => void;
}
export function CompletenessNotice(_p: CompletenessNoticeProps): JSX.Element | null {
  throw new Error('not implemented');
}
