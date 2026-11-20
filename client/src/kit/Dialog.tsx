// Stub for the tests-first commit: the implementation follows.
import { type DialogProps as AriaDialogProps } from 'react-aria-components';

import type { ReactNode } from 'react';

export interface ModalDialogProps {
  title: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

export function ModalDialog({
  title,
  isOpen,
  onOpenChange,
  children,
}: ModalDialogProps): import('react').JSX.Element {
  throw new Error('not implemented');
}

export function Dialog({
  className,
  ...props
}: Omit<AriaDialogProps, 'className'> & {
  className?: string;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}
