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
  /** False: only the dialog's own buttons close it (a choice the user must make). */
  isDismissable?: boolean;
  /** `wide`: most of the viewport (a full-screen panel). */
  size?: 'default' | 'wide';
}

/** A modal dialog with a heading; unless `isDismissable` is false, Escape and the overlay close it. */
export function ModalDialog({
  title,
  isOpen,
  onOpenChange,
  children,
  isDismissable = true,
  size = 'default',
}: ModalDialogProps) {
  return (
    <ModalOverlay
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      className={cx(styles['overlay'])}
    >
      <Modal className={cx(styles['modal'], size === 'wide' ? styles['wideModal'] : undefined)}>
        <AriaDialog className={cx(styles['dialog'], size === 'wide' ? styles['wide'] : undefined)}>
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
