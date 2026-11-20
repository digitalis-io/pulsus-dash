import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';
import { cx } from './cx';

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className={cx(styles['empty'])}>
      <p className={cx(styles['title'])}>{title}</p>
      {children !== undefined && <div className={cx(styles['body'])}>{children}</div>}
    </div>
  );
}
