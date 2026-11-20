/** Shown after Sign out, without the shell. */
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { t } from '../i18n/t';
import { cx } from '../kit/cx';
import { usePageTitle } from '../shell/PageTitle';
import styles from './pages.module.css';

export function SignedOutPage() {
  usePageTitle(t('signedOut.title'));
  const main = useRef<HTMLElement>(null);
  // The control that had focus (the Sign out menu item) is gone. Without a focused element some
  // engines start the next Tab outside the page, so focus moves to the page content.
  useEffect(() => {
    main.current?.focus();
  }, []);
  return (
    <main id="main" ref={main} tabIndex={-1} className={cx(styles['standalone'])}>
      <h1 className={cx(styles['standaloneTitle'])}>{t('signedOut.title')}</h1>
      <Link to="/" className={cx(styles['link'])}>
        {t('signedOut.again')}
      </Link>
    </main>
  );
}
