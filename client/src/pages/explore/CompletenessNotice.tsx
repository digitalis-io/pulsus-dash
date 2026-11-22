/**
 * The completeness notice of an Explore result (plan #63 Part C §3.3, C.2; PRF-031): a truncated
 * result shows the "Partial data" badge, its warnings and Narrow; warnings without truncation show
 * the "Warnings" badge; infos are listed as notes. Each list shows at most five items. Nothing is
 * rendered when there is nothing to say. No state colour: completeness is not an entity state.
 */
import { useId, type JSX } from 'react';
import type { Completeness } from '../../data/decode';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import styles from './Explore.module.css';

export interface CompletenessNoticeProps {
  readonly completeness: Completeness;
  readonly onNarrow: () => void;
}

const MAX_ITEMS = 5;

function Items({ items, labelledBy }: { items: readonly string[]; labelledBy: string }) {
  const more = items.length - MAX_ITEMS;
  return (
    <ul className={cx(styles['noticeList'])} aria-labelledby={labelledBy}>
      {items.slice(0, MAX_ITEMS).map((w, i) => (
        <li key={i}>{w}</li>
      ))}
      {more > 0 && <li>{t('explore.notice.more', { n: more })}</li>}
    </ul>
  );
}

export function CompletenessNotice({
  completeness: c,
  onNarrow,
}: CompletenessNoticeProps): JSX.Element | null {
  const badgeId = useId();
  const notesId = useId();
  const warned = c.truncated || c.warnings.length > 0;
  if (!warned && c.infos.length === 0) return null;
  return (
    <div role="status" aria-label={t('explore.notice.label')} className={cx(styles['notice'])}>
      {warned && (
        <>
          <span
            className={cx(styles['badge'])}
            data-badge={c.truncated ? 'partial' : 'warnings'}
            id={badgeId}
          >
            <Icon name="info" />
            {c.truncated ? t('explore.notice.partial') : t('explore.notice.warnings')}
          </span>
          <Items items={c.warnings} labelledBy={badgeId} />
          {c.truncated && (
            <Button variant="ghost" onPress={onNarrow}>
              {t('explore.narrow')}
            </Button>
          )}
        </>
      )}
      {c.infos.length > 0 && (
        <>
          <span className={cx(styles['label'])} id={notesId}>
            {t('explore.notice.infos')}
          </span>
          <Items items={c.infos} labelledBy={notesId} />
        </>
      )}
    </div>
  );
}
