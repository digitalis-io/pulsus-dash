/**
 * A panel at full screen (plan #61 Part B §4.3): a modal titled with the panel title, the same
 * body filling most of the viewport, and Close. Escape closes; focus returns to the trigger. It
 * shows the panel's own run (plan #64 §3.7): the panel queries while it is open. A LogQL stream
 * panel's `LogStream` shows here on the panel's pager while the panel body yields (plan #67 §3.5).
 * A bar chart shows with the panel's toggles and pick (plan #173 Part 3b §4.3): a click closes the
 * dialog, then inspects; a brush and a clear act in place.
 */
import { useRef } from 'react';
import type { PanelView } from '../../boards/panelRun';
import type { FrameSize } from '../../charts/ChartFrame';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { ModalDialog } from '../../kit/Dialog';
import styles from './Board.module.css';
import { PanelBody, type PanelCategory } from './PanelFrame';

export function PanelFullScreen({
  isOpen,
  title,
  view,
  onNarrow,
  category,
  onClose,
}: {
  isOpen: boolean;
  title: string;
  view: PanelView;
  onNarrow: () => void;
  /** A bar chart's state and actions, shared with the panel (plan #173 Part 3b §4.3). */
  category?: PanelCategory;
  onClose: () => void;
}) {
  // Its own size memo, kept across close and reopen (#90).
  const frameSize = useRef<FrameSize | null>(null);
  return (
    <ModalDialog
      title={title}
      isOpen={isOpen}
      size="wide"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <div className={cx(styles['fullBody'])}>
        {isOpen && (
          <PanelBody
            title={title}
            view={view}
            sizeMemo={frameSize}
            onNarrow={onNarrow}
            {...(category === undefined ? {} : { category })}
          />
        )}
      </div>
      <div className={cx(styles['dialogActions'])}>
        <Button variant="primary" onPress={onClose}>
          {t('panel.close')}
        </Button>
      </div>
    </ModalDialog>
  );
}
