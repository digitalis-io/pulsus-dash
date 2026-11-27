import {
  Dialog as AriaDialog,
  Heading,
  Modal,
  ModalOverlay,
  type DialogProps as AriaDialogProps,
} from 'react-aria-components';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Dialog.module.css';
import { cx } from './cx';

export interface ModalDialogProps {
  title: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  /** False: only the dialog's own buttons close it (a choice the user must make). */
  isDismissable?: boolean;
  /**
   * `wide`: most of the viewport (a full-screen panel). `editor`: a fixed-size editing window,
   * 800 × 720 px, capped to the viewport less 24 px a side; it neither moves nor resizes.
   */
  size?: 'default' | 'wide' | 'editor';
  /**
   * The element the dialog zooms open from and closes back to (#282), read when it opens. Omitted:
   * the element focused at that moment (the trigger), else the viewport centre.
   */
  origin?: () => Element | null;
}

/** The smallest scale the zoom starts from (a point at the origin's centre). */
const ZOOM_MIN_SCALE = 0.04;

/** A length as a percentage of the modal's own box (what `translate` resolves `%` against). */
const pct = (n: number, of: number): string => `${((n / of) * 100).toFixed(2)}%`;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function originRect(origin: (() => Element | null) | undefined): Rect | null {
  const el = origin === undefined ? document.activeElement : origin();
  if (el === null || el === document.body || el === document.documentElement) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/**
 * Sets the modal's zoom start on it (FLIP, #282): the translate from its final centre to the
 * origin's centre and the scale that fits it in the origin's rect, at least `ZOOM_MIN_SCALE`. The
 * layout box (offset*) is read, not the transformed one, so the running animation does not skew it.
 */
function placeZoom(modal: HTMLElement, from: Rect | null): void {
  const w = modal.offsetWidth;
  const h = modal.offsetHeight;
  if (from === null || w === 0 || h === 0) {
    modal.style.removeProperty('--zoom-x');
    modal.style.removeProperty('--zoom-y');
    modal.style.removeProperty('--zoom-scale');
    return;
  }
  const dx = from.x + from.w / 2 - (modal.offsetLeft + w / 2);
  const dy = from.y + from.h / 2 - (modal.offsetTop + h / 2);
  const scale = Math.min(1, Math.max(ZOOM_MIN_SCALE, Math.min(from.w / w, from.h / h)));
  modal.style.setProperty('--zoom-x', pct(dx, w));
  modal.style.setProperty('--zoom-y', pct(dy, h));
  modal.style.setProperty('--zoom-scale', scale.toFixed(3));
}

/** Unmounts once the exit animation ends; then the dialog reports the close (`onExited`). */
function ExitSentinel({ onExited }: { onExited: () => void }) {
  const latest = useRef(onExited);
  useEffect(() => {
    latest.current = onExited;
  });
  useEffect(
    () => () => {
      latest.current();
    },
    [],
  );
  return null;
}

/**
 * A modal dialog with a heading; unless `isDismissable` is false, Escape and the overlay close it.
 * It zooms open from its origin and back to it on close (#282); a close the dialog asks for
 * (Escape, the overlay, a `slot="close"` button) reaches `onOpenChange` once the exit has played,
 * so a parent that unmounts it on close still sees the motion.
 */
export function ModalDialog({
  title,
  isOpen,
  onOpenChange,
  children,
  isDismissable = true,
  size = 'default',
  origin,
}: ModalDialogProps) {
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);
  const shown = isOpen && !closing;
  // The origin is read as the dialog opens, before focus moves into it.
  const [wasShown, setWasShown] = useState(false);
  const [from, setFrom] = useState<Rect | null>(null);
  if (shown !== wasShown) {
    setWasShown(shown);
    if (shown) setFrom(originRect(origin));
  }
  const modalRef = useCallback(
    (el: HTMLElement | null) => {
      if (el !== null) placeZoom(el, from);
    },
    [from],
  );
  const onExited = useCallback(() => {
    if (!closingRef.current) return;
    closingRef.current = false;
    setClosing(false);
    onOpenChange(false);
  }, [onOpenChange]);
  return (
    <ModalOverlay
      isOpen={shown}
      onOpenChange={(open) => {
        if (open) {
          onOpenChange(true);
          return;
        }
        closingRef.current = true;
        setClosing(true);
      }}
      isDismissable={isDismissable}
      isKeyboardDismissDisabled={!isDismissable}
      className={cx(styles['overlay'])}
    >
      <Modal
        ref={modalRef}
        className={cx(
          styles['modal'],
          size === 'wide'
            ? styles['wideModal']
            : size === 'editor'
              ? styles['editorModal']
              : undefined,
        )}
      >
        <AriaDialog
          className={cx(
            styles['dialog'],
            size === 'wide' ? styles['wide'] : size === 'editor' ? styles['editor'] : undefined,
          )}
        >
          <Heading slot="title" className={cx(styles['title'])}>
            {title}
          </Heading>
          {children}
          <ExitSentinel onExited={onExited} />
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
