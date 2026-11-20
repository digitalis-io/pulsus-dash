import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type DialogProps as AriaDialogProps,
} from 'react-aria-components';
import type { ReactNode } from 'react';
import styles from './Dialog.module.css';
import { cx } from './cx';

export interface ModalDialogProps {
  title: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}

/** A modal dialog with a heading; Escape and the overlay close it. */
export function ModalDialog({ title, isOpen, onOpenChange, children }: ModalDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable
      className={cx(styles['overlay'])}
    >
      <Modal className={cx(styles['modal'])}>
        <AriaDialog className={cx(styles['dialog'])}>
          <Heading slot="title" className={cx(styles['title'])}>
            {title}
          </Heading>
          {children}
        </AriaDialog>
      </Modal>
    </ModalOverlay>
  );
}

/** A non-modal dialog for popovers. */
export function Dialog({
  className,
  ...props
}: Omit<AriaDialogProps, 'className'> & { className?: string }) {
  return <AriaDialog {...props} className={cx(styles['plain'], className)} />;
}
