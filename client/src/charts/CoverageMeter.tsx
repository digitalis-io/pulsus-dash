/**
 * The coverage meter under a categorical chart (VIZ-027, T22-006; plan #173 Part 2 §4.4): one line
 * of `coverageText`. When the run or the baseline run is truncated or warned, the line is a ghost
 * button whose popover holds each such run's completeness notice (its warnings, and Narrow when
 * truncated and `onNarrow` is given: a list without a field to narrow has none, plan #216 Part 2a);
 * otherwise it is a status line. Narrow closes the popover after it acts. The stale time is in `timeZone` (default the browser's).
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
  timeZone,
  focusable = false,
}: {
  coverage: Coverage;
  onNarrow?: () => void;
  timeZone?: string;
  /** A tab stop even as a status line (the geomap's Tab order ends at its meter, T24-093). */
  focusable?: boolean;
}): JSX.Element {
  const text = timeZone === undefined ? coverageText(coverage) : coverageText(coverage, timeZone);
  const query = warned(coverage.query) ? coverage.query : null;
  const baseline = warned(coverage.baseline) ? coverage.baseline : null;
  if (query === null && baseline === null) {
    return (
      <div className={cx(styles['meter'])} data-coverage-meter="">
        <p
          role="status"
          className={cx(styles['meterText'])}
          // The geomap's meter closes its Tab order (T24-093).
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
          tabIndex={focusable ? 0 : undefined}
        >
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
            {({ close }) => {
              // Narrow acts, then the popover closes (its focus stays where Narrow put it).
              const narrow =
                onNarrow === undefined
                  ? {}
                  : {
                      onNarrow: () => {
                        onNarrow();
                        close();
                      },
                    };
              return (
                <>
                  {query !== null && (
                    <section>
                      <h4 className={cx(styles['meterHeading'])}>{t('meter.query')}</h4>
                      <CompletenessNotice completeness={query} {...narrow} />
                    </section>
                  )}
                  {baseline !== null && (
                    <section>
                      <h4 className={cx(styles['meterHeading'])}>{t('meter.baseline')}</h4>
                      <CompletenessNotice completeness={baseline} {...narrow} />
                    </section>
                  )}
                </>
              );
            }}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
