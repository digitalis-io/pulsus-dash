/**
 * A panel's completeness badge (plan #64 §3.7, A.11; PRF-031): in the header, "Partial data" for a
 * truncated result or "Warnings" for warnings alone; pressing it opens Explore's completeness notice
 * (the warnings, and Narrow when truncated) in a popover. Nothing when there is nothing to say.
 */
import type { JSX } from 'react';
import { DialogTrigger } from 'react-aria-components';
import type { Completeness } from '../../data/decode';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Dialog } from '../../kit/Dialog';
import { Icon } from '../../kit/Icon';
import { Popover } from '../../kit/Popover';
import { CompletenessNotice } from '../explore/CompletenessNotice';
import styles from './Board.module.css';

export function PanelNotices({
  title,
  completeness,
  onNarrow,
}: {
  title: string;
  completeness: Completeness;
  onNarrow: () => void;
}): JSX.Element | null {
  if (!completeness.truncated && completeness.warnings.length === 0) return null;
  const badge = completeness.truncated ? t('explore.notice.partial') : t('explore.notice.warnings');
  const label = t('panel.notices', { badge, title });
  return (
    <DialogTrigger>
      <Button variant="ghost" className={cx(styles['panelBadge'])} aria-label={label}>
        <Icon name="info" />
        {badge}
      </Button>
      <Popover placement="bottom end">
        <Dialog aria-label={label} className={cx(styles['panelNotices'])}>
          <CompletenessNotice completeness={completeness} onNarrow={onNarrow} />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
