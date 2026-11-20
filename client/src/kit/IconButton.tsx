import type { ButtonProps as AriaButtonProps } from 'react-aria-components';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import styles from './IconButton.module.css';
import { cx } from './cx';

export interface IconButtonProps extends Omit<AriaButtonProps, 'className' | 'children'> {
  icon: IconName;
  'aria-label': string;
  className?: string;
}

/** A square icon-only button (≥ 24 × 24 px target, T08-010) with an accessible name. */
export function IconButton({ icon, className, ...props }: IconButtonProps) {
  return (
    <Button {...props} variant="ghost" className={cx(styles['iconButton'], className)}>
      <Icon name={icon} />
    </Button>
  );
}
