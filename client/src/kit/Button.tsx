// Stub for the tests-first commit: the implementation follows.
import { type ButtonProps as AriaButtonProps } from 'react-aria-components';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends Omit<AriaButtonProps, 'className'> {
  variant?: ButtonVariant;
  className?: string;
}

export function Button({ variant, className, ...props }: ButtonProps): import('react').JSX.Element {
  throw new Error('not implemented');
}
