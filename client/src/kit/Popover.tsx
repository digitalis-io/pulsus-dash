import {
  Popover as AriaPopover,
  type PopoverProps as AriaPopoverProps,
} from 'react-aria-components';
import { space } from '../styles/tokens';
import styles from './Popover.module.css';
import { cx } from './cx';

export interface PopoverProps extends Omit<AriaPopoverProps, 'className' | 'offset'> {
  className?: string;
}

export function Popover({ className, ...props }: PopoverProps) {
  return (
    <AriaPopover
      offset={space['1']}
      containerPadding={space['3']}
      {...props}
      className={cx(styles['popover'], className)}
    />
  );
}
