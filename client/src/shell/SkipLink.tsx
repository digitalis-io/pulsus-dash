import type { MouseEvent } from 'react';
import { t } from '../i18n/t';
import styles from './SkipLink.module.css';
import { cx } from '../kit/cx';

/** The first tab stop: moves focus to `<main id="main">`. */
export function SkipLink() {
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault();
    document.getElementById('main')?.focus();
  };
  return (
    <a href="#main" className={cx(styles['skip'])} onClick={onClick}>
      {t('skip.main')}
    </a>
  );
}
