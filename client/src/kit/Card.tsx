import type { ReactNode } from 'react';
import { useId } from 'react';
import styles from './Card.module.css';
import { cx } from './cx';

/** A titled section of a page. */
export function Card({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={cx(styles['card'])} aria-labelledby={id}>
      <h2 id={id} className={cx(styles['title'])}>
        {title}
      </h2>
      {children}
    </section>
  );
}
