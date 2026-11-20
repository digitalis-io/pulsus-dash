/**
 * The share controls of a view (IA-023, T08-015, T03-017): `Keep relative`, `Copy link`, the copy
 * status and the `Share link` fallback field shown when the clipboard is unavailable. Copy link
 * pins relative times to the clock anchor unless Keep relative is checked. Used by the time range
 * dialog and by the board's Share popover; reads the route and the time Context.
 */
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { t } from '../i18n/t';
import { Button } from '../kit/Button';
import { Checkbox } from '../kit/Checkbox';
import { cx } from '../kit/cx';
import { Icon } from '../kit/Icon';
import { useTimeContext } from '../state/useTimeContext';
import { buildShareUrl, parseViewUrl } from '../state/viewUrl';
import styles from './ShareLinkControls.module.css';

type CopyStatus = 'idle' | 'copied' | 'failed';

/** A fragment: its parent lays the rows out. */
export function ShareLinkControls() {
  const { search, timeZone, anchorMs } = useTimeContext();
  const { pathname } = useLocation();
  const [keepRelative, setKeepRelative] = useState(false);
  const [copy, setCopy] = useState<CopyStatus>('idle');
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const shareRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fallbackUrl === null) return;
    shareRef.current?.focus();
    shareRef.current?.select();
  }, [fallbackUrl]);

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

  return (
    <>
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
    </>
  );
}
