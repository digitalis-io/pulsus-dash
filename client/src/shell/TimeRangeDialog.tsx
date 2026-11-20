/**
 * The time range dialog (IA-020, IA-023, T08-008), loaded lazily by `TimeRangePicker`. In DOM order:
 * quick ranges, From and To fields, a range calendar in the browser zone, the zone, Apply, and the
 * share controls. Apply validates both fields and focuses the first invalid one; Copy link pins
 * relative times to the clock anchor unless "Keep relative" is checked (T03-017).
 */
import {
  fromAbsolute,
  toCalendarDate,
  toZoned,
  type CalendarDate,
  type DateValue,
} from '@internationalized/date';
import { useEffect, useRef, useState } from 'react';
import {
  Button as AriaButton,
  CalendarCell,
  CalendarGrid,
  Heading,
  ListBox,
  ListBoxItem,
  RangeCalendar,
  type Key,
  type RangeValue,
  type Selection,
} from 'react-aria-components';
import { useLocation } from 'react-router';
import { formatZone, QUICK_RANGES, quickRangeLabel, quickRangeOf } from '../i18n/format';
import { t } from '../i18n/t';
import { Button } from '../kit/Button';
import { Checkbox } from '../kit/Checkbox';
import { Icon } from '../kit/Icon';
import { TextField } from '../kit/TextField';
import {
  parseTimeExpr,
  printTimeExpr,
  resolveTimeExpr,
  timeExprErrorMessage,
} from '../state/timeExpr';
import type { TimeContext } from '../state/useTimeContext';
import { buildShareUrl, parseViewUrl } from '../state/viewUrl';
import styles from './TimeRangeDialog.module.css';
import { cx } from '../kit/cx';

type CopyStatus = 'idle' | 'copied' | 'failed';

function startOfDayIso(d: CalendarDate, timeZone: string): string {
  return printTimeExpr({ kind: 'absolute', ms: toZoned(d, timeZone).toDate().getTime() });
}

function calendarRange(fromMs: number, toMs: number, timeZone: string): RangeValue<CalendarDate> {
  const start = toCalendarDate(fromAbsolute(fromMs, timeZone));
  const end = toCalendarDate(fromAbsolute(Math.max(fromMs, toMs - 1), timeZone));
  return { start, end };
}

export interface TimeRangeDialogProps {
  time: TimeContext;
  onClose: () => void;
}

export function TimeRangeDialog({ time, onClose }: TimeRangeDialogProps) {
  const { search, window, timeZone, anchorMs, dispatch } = time;
  const { pathname } = useLocation();
  const [from, setFrom] = useState(search.from);
  const [to, setTo] = useState(search.to);
  const [fromError, setFromError] = useState<string | null>(null);
  const [toError, setToError] = useState<string | null>(null);
  const [range, setRange] = useState(() => calendarRange(window.fromMs, window.toMs, timeZone));
  const [keepRelative, setKeepRelative] = useState(false);
  const [copy, setCopy] = useState<CopyStatus>('idle');
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const fromRef = useRef<HTMLInputElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const shareRef = useRef<HTMLInputElement>(null);

  const quick = quickRangeOf(search);

  useEffect(() => {
    if (fallbackUrl === null) return;
    shareRef.current?.focus();
    shareRef.current?.select();
  }, [fallbackUrl]);

  const onQuick = (keys: Selection): void => {
    if (keys !== 'all') {
      const [key] = [...keys];
      if (typeof key === 'string') dispatch({ type: 'setRange', from: `now-${key}`, to: 'now' });
    }
    onClose();
  };

  const onCalendar = (r: RangeValue<DateValue> | null): void => {
    if (r === null) return;
    const start = toCalendarDate(r.start);
    const end = toCalendarDate(r.end);
    setRange({ start, end });
    setFrom(startOfDayIso(start, timeZone));
    setTo(startOfDayIso(end.add({ days: 1 }), timeZone));
    setFromError(null);
    setToError(null);
  };

  const apply = (): void => {
    const f = parseTimeExpr(from.trim());
    const tt = parseTimeExpr(to.trim());
    setFromError(f.ok ? null : timeExprErrorMessage(f.error));
    setToError(tt.ok ? null : timeExprErrorMessage(tt.error));
    if (!f.ok) {
      fromRef.current?.focus();
      return;
    }
    if (!tt.ok) {
      toRef.current?.focus();
      return;
    }
    const fromMs = resolveTimeExpr(f.expr, anchorMs, timeZone);
    const toMs = resolveTimeExpr(tt.expr, anchorMs, timeZone);
    if (fromMs >= toMs) {
      setToError(t('time.toNotAfterFrom'));
      toRef.current?.focus();
      return;
    }
    dispatch({ type: 'setRange', from: printTimeExpr(f.expr), to: printTimeExpr(tt.expr) });
    onClose();
  };

  const view = parseViewUrl(pathname, anchorMs, timeZone);
  const copyLink = (): void => {
    if (view === null) return;
    const url = buildShareUrl(
      globalThis.location.origin,
      { route: view.route, context: search },
      { keepRelative, anchorMs, timeZone },
    );
    setFallbackUrl(null);
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(url))
      .then(
        () => {
          setCopy('copied');
        },
        () => {
          setCopy('failed');
          setFallbackUrl(url);
        },
      );
  };

  const selected: Key[] = quick === null ? [] : [quick];

  return (
    <div className={cx(styles['dialog'])}>
      <ListBox
        aria-label={t('time.quickRanges')}
        selectionMode="single"
        selectedKeys={selected}
        onSelectionChange={onQuick}
        autoFocus
        className={cx(styles['quick'])}
      >
        {QUICK_RANGES.map((q) => (
          <ListBoxItem key={q} id={q} className={cx(styles['option'])}>
            {quickRangeLabel(q)}
          </ListBoxItem>
        ))}
      </ListBox>
      <div className={cx(styles['custom'])}>
        <div className={cx(styles['fields'])}>
          <TextField
            label={t('time.from')}
            value={from}
            onChange={setFrom}
            error={fromError}
            mono
            inputRef={fromRef}
            autoComplete="off"
            spellCheck="false"
          />
          <TextField
            label={t('time.to')}
            value={to}
            onChange={setTo}
            error={toError}
            mono
            inputRef={toRef}
            autoComplete="off"
            spellCheck="false"
          />
        </div>
        <RangeCalendar
          aria-label={t('time.calendar')}
          value={range}
          onChange={onCalendar}
          defaultFocusedValue={range.start}
          className={cx(styles['calendar'])}
        >
          <div className={cx(styles['calendarHeader'])}>
            <AriaButton
              slot="previous"
              aria-label={t('time.previous')}
              className={cx(styles['nav'])}
            >
              ‹
            </AriaButton>
            <Heading className={cx(styles['heading'])} />
            <AriaButton slot="next" aria-label={t('time.next')} className={cx(styles['nav'])}>
              ›
            </AriaButton>
          </div>
          <CalendarGrid className={cx(styles['grid'])}>
            {(date) => <CalendarCell date={date} className={cx(styles['cell'])} />}
          </CalendarGrid>
        </RangeCalendar>
        <p className={cx(styles['zone'])}>
          <Icon name="calendar" />
          {t('time.zone', { zone: formatZone(timeZone, anchorMs) })}
        </p>
        <div className={cx(styles['actions'])}>
          <Button variant="primary" onPress={apply}>
            {t('time.apply')}
          </Button>
        </div>
        {view !== null && (
          <div className={cx(styles['share'])}>
            <Checkbox isSelected={keepRelative} onChange={setKeepRelative}>
              {t('time.keepRelative')}
            </Checkbox>
            <Button onPress={copyLink}>
              <Icon name="link" />
              {t('time.copyLink')}
            </Button>
          </div>
        )}
        <p role="status" className={cx(styles['status'])}>
          {copy === 'copied' ? t('time.linkCopied') : copy === 'failed' ? t('time.copyFailed') : ''}
        </p>
        {fallbackUrl !== null && (
          <label className={cx(styles['fallback'])}>
            <span className={cx(styles['fallbackLabel'])}>{t('time.shareLink')}</span>
            <input
              ref={shareRef}
              readOnly
              value={fallbackUrl}
              className={cx(styles['fallbackInput'])}
            />
          </label>
        )}
      </div>
    </div>
  );
}
