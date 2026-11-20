/** "Showing <window> (<zone>)": the page's view of the same time Context as the header (IA-002). */
import { formatRange } from '../i18n/format';
import { t } from '../i18n/t';
import { useTimeContext } from '../state/useTimeContext';
import styles from './ContextSummary.module.css';
import { cx } from '../kit/cx';

export function ContextSummary() {
  const { window, timeZone } = useTimeContext();
  return (
    <p className={cx(styles['summary'])}>
      {t('summary.showing', {
        range: formatRange(window.fromMs, window.toMs, timeZone),
        zone: timeZone,
      })}
    </p>
  );
}
