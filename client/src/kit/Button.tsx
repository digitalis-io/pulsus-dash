import { Button as AriaButton, type ButtonProps as AriaButtonProps } from 'react-aria-components';
import styles from './Button.module.css';
import { cx } from './cx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export interface ButtonProps extends Omit<AriaButtonProps, 'className'> {
  variant?: ButtonVariant;
  className?: string;
}

export function Button({ variant = 'secondary', className, ...props }: ButtonProps) {
  return <AriaButton {...props} className={cx(styles['button'], styles[variant], className)} />;
}
