// Stub for the tests-first commit: the implementation follows.
import type { TimeContext } from '../state/useTimeContext';

export interface TimeRangeDialogProps {
  time: TimeContext;
  onClose: () => void;
}

export function TimeRangeDialog({
  time,
  onClose,
}: TimeRangeDialogProps): import('react').JSX.Element {
  throw new Error('not implemented');
}
