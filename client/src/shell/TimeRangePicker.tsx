/**
 * The time range trigger in the header (IA-020): the range description and, for relative ranges on
 * wide viewports (≥ 1520 px), the absolute window. Opens `TimeRangeDialog`, loaded lazily and
 * prefetched on hover and focus.
 */
import { lazy, Suspense, useState } from 'react';
import { Button, DialogTrigger } from 'react-aria-components';
import { describeRange, formatRangeShort } from '../i18n/format';
import { t } from '../i18n/t';
import { Dialog } from '../kit/Dialog';
import { Icon } from '../kit/Icon';
import { Popover } from '../kit/Popover';
import { isAbsolute } from '../state/timeExpr';
import { useTimeContext } from '../state/useTimeContext';
import styles from './TimeRangePicker.module.css';
import { cx } from '../kit/cx';

const loadDialog = () => import('./TimeRangeDialog');
const TimeRangeDialog = lazy(() => loadDialog().then((m) => ({ default: m.TimeRangeDialog })));

function prefetch(): void {
  loadDialog().catch(() => undefined);
}

export function TimeRangePicker() {
  const time = useTimeContext();
  const [open, setOpen] = useState(false);
  const { search, window, timeZone, anchorMs } = time;
  const relative = !(isAbsolute(search.from) && isAbsolute(search.to));
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button className={cx(styles['trigger'])} onHoverStart={prefetch} onFocus={prefetch}>
        <Icon name="clock" />
        <span className={cx(styles['range'])}>{describeRange(search, anchorMs, timeZone)}</span>
        {relative && (
          <span className={cx(styles['absolute'])}>
            {formatRangeShort(window.fromMs, window.toMs, timeZone)}
          </span>
        )}
        <Icon name="chevron-down" className={cx(styles['chevron'])} />
      </Button>
      <Popover placement="bottom end">
        <Dialog aria-label={t('time.dialog')}>
          <Suspense fallback={<div className={cx(styles['loading'])} aria-busy="true" />}>
            <TimeRangeDialog
              time={time}
              onClose={() => {
                setOpen(false);
              }}
            />
          </Suspense>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
