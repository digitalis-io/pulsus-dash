// Stub for the tests-first commit: the implementation follows.
import type { ReactElement } from 'react';

export interface TooltipProps {
  label: string;
  /** Show the tooltip only when true (for example, only in the collapsed sidebar). */
  isEnabled?: boolean;
  children: ReactElement;
}

export function Tooltip({ label, isEnabled, children }: TooltipProps): import('react').JSX.Element {
  throw new Error('not implemented');
}
