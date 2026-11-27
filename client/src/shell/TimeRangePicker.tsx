/**
 * The time range control in the header (IA-020 as amended, #282 Part 2a): a group of the inline
 * quick ranges (15m, 1h, 6h, 24h and 7d, from 1280 px wide) and the trigger. The trigger shows the
 * range description and, for relative ranges on wide viewports (≥ 1520 px), the absolute window,
 * and opens `TimeRangeDialog`, loaded lazily and prefetched on hover and focus.
 */
import { lazy, Suspense, useState } from 'react';
import { Button, DialogTrigger } from 'react-aria-components';
import {
  describeRange,
  formatRangeShort,
  quickRangeLabel,
  quickRangeOf,
  type QuickRange,
} from '../i18n/format';
import { t, type MessageId } from '../i18n/t';
import { Dialog } from '../kit/Dialog';
import { Icon } from '../kit/Icon';
import { Popover } from '../kit/Popover';
import { SegmentedControl, type SegmentedOption } from '../kit/SegmentedControl';
import { isAbsolute } from '../state/timeExpr';
import { useTimeContext } from '../state/useTimeContext';
import styles from './TimeRangePicker.module.css';
import { cx } from '../kit/cx';

const loadDialog = () => import('./TimeRangeDialog');
const TimeRangeDialog = lazy(() => loadDialog().then((m) => ({ default: m.TimeRangeDialog })));

function prefetch(): void {
  loadDialog().catch(() => undefined);
}

/** The inline presets and their short labels. */
const PRESETS = ['15m', '1h', '6h', '24h', '7d'] as const satisfies readonly QuickRange[];
type Preset = (typeof PRESETS)[number];
const SHORT: Readonly<Record<Preset, MessageId>> = {
  '15m': 'time.short.15m',
  '1h': 'time.short.1h',
  '6h': 'time.short.6h',
  '24h': 'time.short.24h',
  '7d': 'time.short.7d',
};

function presetOf(q: QuickRange | null): Preset | null {
  return q !== null && (PRESETS as readonly string[]).includes(q) ? (q as Preset) : null;
}

export function TimeRangePicker() {
  const time = useTimeContext();
  const [open, setOpen] = useState(false);
  const { search, window, timeZone, anchorMs, dispatch } = time;
  const relative = !(isAbsolute(search.from) && isAbsolute(search.to));
  const options: SegmentedOption<Preset>[] = PRESETS.map((q) => ({
    id: q,
    label: t(SHORT[q]),
    ariaLabel: quickRangeLabel(q),
  }));
  return (
    <div role="group" aria-label={t('time.dialog')} className={cx(styles['group'])}>
      <span className={cx(styles['presets'])}>
        <SegmentedControl
          label={t('time.presets')}
          options={options}
          value={presetOf(quickRangeOf(search))}
          onChange={(q) => {
            dispatch({ type: 'setRange', from: `now-${q}`, to: 'now' });
          }}
        />
      </span>
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
    </div>
  );
}
