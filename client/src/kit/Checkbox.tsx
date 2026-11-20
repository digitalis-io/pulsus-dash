import { CheckboxButton, CheckboxField, type CheckboxFieldProps } from 'react-aria-components';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from './cx';
import styles from './Checkbox.module.css';

export function Checkbox({
  children,
  ...props
}: Omit<CheckboxFieldProps, 'className' | 'children'> & { children: ReactNode }) {
  return (
    <CheckboxField {...props}>
      <CheckboxButton className={cx(styles['checkbox'])}>
        {({ isSelected }) => (
          <>
            <span className={cx(styles['box'])}>{isSelected && <Icon name="check" />}</span>
            {children}
          </>
        )}
      </CheckboxButton>
    </CheckboxField>
  );
}
