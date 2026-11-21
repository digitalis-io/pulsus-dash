/**
 * "This board was changed" (plan #61 Part B §4.4): a save hit a newer version. The user keeps
 * their draft as a new version or loads the other one; the dialog closes only by one of the two.
 */
import type { Board } from '../../api/types';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { ModalDialog } from '../../kit/Dialog';
import styles from './Board.module.css';

export function BoardConflict({
  current,
  onOverwrite,
  onTakeTheirs,
}: {
  current: Board;
  onOverwrite: () => void;
  onTakeTheirs: () => void;
}) {
  return (
    <ModalDialog
      title={t('board.conflictTitle')}
      isOpen
      isDismissable={false}
      onOpenChange={() => undefined}
    >
      <p className={cx(styles['dialogBody'])}>
        {t('board.conflictBody', { version: current.version })}
      </p>
      <div className={cx(styles['dialogActions'])}>
        <Button onPress={onTakeTheirs}>{t('board.discardMine')}</Button>
        <Button variant="primary" onPress={onOverwrite}>
          {t('board.overwrite')}
        </Button>
      </div>
    </ModalDialog>
  );
}
