/**
 * The wheel-zoom hint (INT §4.1): a time chart zooms only with `Ctrl`/`⌘` held, so a plain wheel
 * over its plot scrolls the page and shows "Hold Ctrl to zoom" ("Hold ⌘ to zoom" on Apple
 * platforms) over the chart for 1.2 s. One hint per page per `WHEEL_HINT_GAP_MS`; it fades (no
 * fade with reduced motion); the polite live region speaks it once per session.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { isApplePlatform } from '../theme/platform';
import styles from './WheelHint.module.css';

export const WHEEL_HINT_MS = 1200;
/** The throttle: at most one hint per page in this window. */
export const WHEEL_HINT_GAP_MS = 3000;

let lastShown = -Infinity;
let announced = false;

/** Test-only: forgets the page throttle and the session's announcement. */
export function resetWheelHint(): void {
  lastShown = -Infinity;
  announced = false;
}

export function wheelHintText(): string {
  const apple = typeof navigator !== 'undefined' && isApplePlatform(navigator);
  return t('chart.wheelHint', { key: apple ? '⌘' : 'Ctrl' });
}

/** `show` for the frame's `wheelHint` event; `hint` goes inside the positioned frame. */
export function useWheelHint(): { show: () => void; hint: ReactNode } {
  const [visible, setVisible] = useState(false);
  const [live, setLive] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const show = useCallback(() => {
    const now = Date.now();
    if (now - lastShown < WHEEL_HINT_GAP_MS) return;
    lastShown = now;
    setVisible(true);
    if (!announced) {
      announced = true;
      setLive(wheelHintText());
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      setVisible(false);
    }, WHEEL_HINT_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
    [],
  );

  const hint = (
    <>
      <div
        className={cx(styles['hint'])}
        data-wheel-hint=""
        data-visible={visible ? 'true' : 'false'}
        aria-hidden="true"
      >
        {visible ? wheelHintText() : ''}
      </div>
      <span className={cx(styles['srOnly'])} aria-live="polite" data-wheel-hint-live="">
        {live}
      </span>
    </>
  );
  return { show, hint };
}
