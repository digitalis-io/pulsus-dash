// Stub for the tests-first commit: the implementation follows.
import type { ButtonProps as AriaButtonProps } from 'react-aria-components';

import { type IconName } from './Icon';

export interface IconButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  icon: IconName;
  'aria-label': string;
  className?: string;
}

export function IconButton({
  icon,
  className,
  ...props
}: IconButtonProps): import('react').JSX.Element {
  throw new Error('not implemented');
}
