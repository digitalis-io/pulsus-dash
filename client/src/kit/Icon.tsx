// Stub for the tests-first commit: the implementation follows.
export type IconName =
  | 'activity'
  | 'layout-dashboard'
  | 'chart-line'
  | 'scroll-text'
  | 'settings'
  | 'panel-left-close'
  | 'panel-left-open'
  | 'clock'
  | 'refresh-cw'
  | 'chevron-down'
  | 'sun'
  | 'moon'
  | 'monitor'
  | 'info'
  | 'log-out'
  | 'link'
  | 'calendar'
  | 'check';

export function Icon({
  name,
  className,
}: {
  name: IconName;
  className?: string;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}
