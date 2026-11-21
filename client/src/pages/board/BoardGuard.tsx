/** "Discard unsaved changes?" (plan #61 Part B §4.2): before leaving or finishing a dirty board. */
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { ModalDialog } from '../../kit/Dialog';
import styles from './Board.module.css';

export function BoardGuard({ onKeep, onDiscard }: { onKeep: () => void; onDiscard: () => void }) {
  return (
    <ModalDialog
      title={t('board.guardTitle')}
      isOpen
      onOpenChange={(open) => {
        if (!open) onKeep();
      }}
    >
      <p className={cx(styles['dialogBody'])}>{t('board.guardBody')}</p>
      <div className={cx(styles['dialogActions'])}>
        <Button onPress={onKeep}>{t('board.keepEditing')}</Button>
        <Button variant="primary" onPress={onDiscard}>
          {t('board.discardChanges')}
        </Button>
      </div>
    </ModalDialog>
  );
}
