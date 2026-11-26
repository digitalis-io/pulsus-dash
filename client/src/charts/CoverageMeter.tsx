/**
 * The coverage meter under a categorical chart (VIZ-027, T22-006; plan #173 Part 2 §4.4): one line
 * of `coverageText`. When the run or the baseline run is truncated or warned, the line is a ghost
 * button whose popover holds each such run's completeness notice (its warnings, and Narrow when
 * truncated); otherwise it is a status line.
 */
import type { JSX } from 'react';
import { DialogTrigger } from 'react-aria-components';
import type { Completeness } from '../data/decode';
import type { Coverage } from '../data/frames';
import { t } from '../i18n/t';
import { Button } from '../kit/Button';
import { cx } from '../kit/cx';
import { Dialog } from '../kit/Dialog';
import { Popover } from '../kit/Popover';
import { CompletenessNotice } from '../pages/explore/CompletenessNotice';
import { coverageText } from '../vis/reduce';
import styles from './CategoryChart.module.css';

const warned = (c: Completeness | null): c is Completeness =>
  c !== null && (c.truncated || c.warnings.length > 0);

export function CoverageMeter({
  coverage,
  onNarrow,
}: {
  coverage: Coverage;
  onNarrow: () => void;
}): JSX.Element {
  const text = coverageText(coverage);
  const query = warned(coverage.query) ? coverage.query : null;
  const baseline = warned(coverage.baseline) ? coverage.baseline : null;
  if (query === null && baseline === null) {
    return (
      <div className={cx(styles['meter'])} data-coverage-meter="">
        <p role="status" className={cx(styles['meterText'])}>
          {text}
        </p>
      </div>
    );
  }
  const label = t('meter.label', { text });
  return (
    <div className={cx(styles['meter'])} data-coverage-meter="">
      <DialogTrigger>
        <Button variant="ghost" aria-label={label} className={cx(styles['meterButton'])}>
          {text}
        </Button>
        <Popover placement="bottom start">
          <Dialog aria-label={label} className={cx(styles['meterPopover'])}>
            {query !== null && (
              <section>
                <h4 className={cx(styles['meterHeading'])}>{t('meter.query')}</h4>
                <CompletenessNotice completeness={query} onNarrow={onNarrow} />
              </section>
            )}
            {baseline !== null && (
              <section>
                <h4 className={cx(styles['meterHeading'])}>{t('meter.baseline')}</h4>
                <CompletenessNotice completeness={baseline} onNarrow={onNarrow} />
              </section>
            )}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
