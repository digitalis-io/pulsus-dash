/** Share (IA-023, T08-015): a popover dialog with the view's share controls. */
import { DialogTrigger, Heading } from 'react-aria-components';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Dialog } from '../../kit/Dialog';
import { Icon } from '../../kit/Icon';
import { Popover } from '../../kit/Popover';
import { ShareLinkControls } from '../../shell/ShareLinkControls';
import styles from './Board.module.css';

export function BoardShare() {
  return (
    <DialogTrigger>
      <Button variant="ghost">
        <Icon name="share-2" />
        {t('board.share')}
      </Button>
      <Popover placement="bottom end">
        <Dialog aria-label={t('board.shareTitle')} className={cx(styles['share'])}>
          <Heading slot="title" className={cx(styles['shareTitle'])}>
            {t('board.shareTitle')}
          </Heading>
          <ShareLinkControls />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
