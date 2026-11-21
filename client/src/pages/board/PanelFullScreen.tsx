/**
 * A panel at full screen (plan #61 Part B §4.3): a modal titled with the panel title, the same
 * body filling most of the viewport, and Close. Escape closes; focus returns to the trigger.
 */
import { useRef } from 'react';
import type { PanelData } from '../../api/types';
import type { FrameSize } from '../../charts/ChartFrame';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { ModalDialog } from '../../kit/Dialog';
import styles from './Board.module.css';
import { PanelBody } from './PanelFrame';

export function PanelFullScreen({
  isOpen,
  title,
  data,
  isError,
  onClose,
}: {
  isOpen: boolean;
  title: string;
  data: PanelData | undefined;
  isError: boolean;
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
        {isOpen && <PanelBody title={title} data={data} isError={isError} sizeMemo={frameSize} />}
      </div>
      <div className={cx(styles['dialogActions'])}>
        <Button variant="primary" onPress={onClose}>
          {t('panel.close')}
        </Button>
      </div>
    </ModalDialog>
  );
}
