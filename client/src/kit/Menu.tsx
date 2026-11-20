import {
  Menu as AriaMenu,
  MenuItem as AriaMenuItem,
  MenuSection as AriaMenuSection,
  Header,
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type MenuSectionProps as AriaMenuSectionProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import { Icon } from './Icon';
import styles from './Menu.module.css';
import { cx } from './cx';

export function Menu<T extends object>({
  className,
  ...props
}: Omit<AriaMenuProps<T>, 'className'> & { className?: string }) {
  return <AriaMenu {...props} className={cx(styles['menu'], className)} />;
}

export interface MenuItemProps<T> extends Omit<AriaMenuItemProps<T>, 'className' | 'children'> {
  children: ReactNode;
  icon?: ReactNode;
}

/** A menu item; in a selectable menu or section it shows a check when selected. */
export function MenuItem<T extends object>({ children, icon, ...props }: MenuItemProps<T>) {
  const textValue = props.textValue ?? (typeof children === 'string' ? children : undefined);
  return (
    <AriaMenuItem
      {...props}
      {...(textValue === undefined ? {} : { textValue })}
      className={cx(styles['item'])}
    >
      {({ isSelected, selectionMode }) => (
        <>
          {selectionMode !== 'none' && (
            <span className={cx(styles['check'])}>{isSelected && <Icon name="check" />}</span>
          )}
          {icon}
          <span className={cx(styles['label'])}>{children}</span>
        </>
      )}
    </AriaMenuItem>
  );
}

export function MenuSection<T extends object>({
  title,
  children,
  ...props
}: Omit<AriaMenuSectionProps<T>, 'className' | 'children'> & {
  title?: string;
  children: ReactNode;
}) {
  return (
    <AriaMenuSection {...props} className={cx(styles['section'])}>
      {title !== undefined && <Header className={cx(styles['header'])}>{title}</Header>}
      {children}
    </AriaMenuSection>
  );
}
