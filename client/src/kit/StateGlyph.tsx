/**
 * A state glyph (T08 §4.4, T02-003, VIZ-067): the state's glyph and name in its state colour, so a
 * state is never shown by colour alone. The glyph is decorative; the name is read.
 */
import type { JSX } from 'react';
import { t } from '../i18n/t';
import { StateEncoding, type State } from '../theme/stateEncoding';
import { cx } from './cx';
import styles from './StateGlyph.module.css';

export function StateGlyph(p: { readonly state: State; readonly className?: string }): JSX.Element {
  const e = StateEncoding[p.state];
  return (
    <span className={cx(styles['stateGlyph'], e.className, p.className)} data-state={p.state}>
      <span aria-hidden="true">{e.glyph}</span> {t(e.label)}
    </span>
  );
}
