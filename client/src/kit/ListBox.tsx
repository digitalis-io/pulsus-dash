/**
 * A list box (T08-007): React Aria's `ListBox` in the kit's menu-row style, 28 px rows, single or
 * multiple selection (a check in the leading column of a selected row), disabled rows muted. Used
 * inside an `Autocomplete` the rows take virtual focus (`aria-activedescendant`) while the search
 * field keeps the DOM focus.
 */
import type { ReactNode } from 'react';
import {
  ListBox as AriaListBox,
  ListBoxItem as AriaListBoxItem,
  type ListBoxItemProps as AriaListBoxItemProps,
  type ListBoxProps as AriaListBoxProps,
} from 'react-aria-components';
import { Icon } from './Icon';
import styles from './ListBox.module.css';
import { cx } from './cx';

export interface ListBoxProps<T extends object> extends Omit<
  AriaListBoxProps<T>,
  'className' | 'children'
> {
  className?: string;
  children: ReactNode;
}

export function ListBox<T extends object>({ className, children, ...props }: ListBoxProps<T>) {
  return (
    <AriaListBox {...props} className={cx(styles['list'], className)}>
      {children}
    </AriaListBox>
  );
}

export interface ListBoxItemProps extends Omit<AriaListBoxItemProps, 'className' | 'children'> {
  /** The row's text; `tag` is shown after it, muted. */
  label: string;
  tag?: string;
  /** Shows the selection check column (multiple selection). */
  check?: boolean;
  /** A note row: italic, muted. */
  note?: boolean;
}

export function ListBoxItem({
  label,
  tag,
  check = false,
  note = false,
  ...props
}: ListBoxItemProps) {
  return (
    <AriaListBoxItem
      {...props}
      textValue={props.textValue ?? label}
      className={cx(styles['item'], note ? styles['note'] : undefined)}
    >
      {({ isSelected }) => (
        <>
          {check && (
            <span className={cx(styles['check'])} aria-hidden="true">
              {isSelected ? <Icon name="check" /> : null}
            </span>
          )}
          <span className={cx(styles['label'])}>{label}</span>
          {tag !== undefined && <span className={cx(styles['tag'])}>{tag}</span>}
        </>
      )}
    </AriaListBoxItem>
  );
}
