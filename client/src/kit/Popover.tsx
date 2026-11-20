// Stub for the tests-first commit: the implementation follows.
import { type PopoverProps as AriaPopoverProps } from 'react-aria-components';

export interface PopoverProps extends Omit<AriaPopoverProps, 'className' | 'offset'> {
  className?: string;
}

export function Popover({ className, ...props }: PopoverProps): import('react').JSX.Element {
  throw new Error('not implemented');
}
