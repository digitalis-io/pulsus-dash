// Stub for the tests-first commit: the implementation follows.
import {
  type MenuItemProps as AriaMenuItemProps,
  type MenuProps as AriaMenuProps,
  type MenuSectionProps as AriaMenuSectionProps,
} from 'react-aria-components';

import type { ReactNode } from 'react';

export function Menu<T extends object>({
  className,
  ...props
}: Omit<AriaMenuProps<T>, 'className'> & {
  className?: string;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}

export interface MenuItemProps<T> extends Omit<AriaMenuItemProps<T>, 'className' | 'children'> {
  children: ReactNode;
  icon?: ReactNode;
}

export function MenuItem<T extends object>({
  children,
  icon,
  ...props
}: MenuItemProps<T>): import('react').JSX.Element {
  throw new Error('not implemented');
}

export function MenuSection<T extends object>({
  title,
  children,
  ...props
}: Omit<AriaMenuSectionProps<T>, 'className' | 'children'> & {
  title?: string;
  children: ReactNode;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}
