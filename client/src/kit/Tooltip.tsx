import { Tooltip as AriaTooltip, TooltipTrigger } from 'react-aria-components';
import type { ReactElement } from 'react';
import { motion, space } from '../styles/tokens';
import styles from './Tooltip.module.css';
import { cx } from './cx';

export interface TooltipProps {
  label: string;
  /** Show the tooltip only when true (for example, only in the collapsed sidebar). */
  isEnabled?: boolean;
  children: ReactElement;
}

/** A label shown on hover and keyboard focus, to the right of the trigger. */
export function Tooltip({ label, isEnabled = true, children }: TooltipProps) {
  if (!isEnabled) return children;
  return (
    <TooltipTrigger delay={motion.standard} closeDelay={motion.fast}>
      {children}
      <AriaTooltip placement="end" offset={space['2']} className={cx(styles['tooltip'])}>
        {label}
      </AriaTooltip>
    </TooltipTrigger>
  );
}
