/**
 * A state glyph (T08 §4.4, T02-003, VIZ-067): the state's glyph and name in its state colour, so a
 * state is never shown by colour alone. The glyph is decorative; the name is read. The `tag`
 * variant (#282 Part 2a) is a 20 px tag tinted in the state colour: the glyph in the state colour,
 * the name in `text` (state-coloured text on a tint would lose contrast).
 */
import type { JSX } from 'react';
import { t } from '../i18n/t';
import { StateEncoding, type State } from '../theme/stateEncoding';
import { cx } from './cx';
import styles from './StateGlyph.module.css';

export function StateGlyph(p: {
  readonly state: State;
  readonly className?: string;
  /** `text` (the default): glyph and name in the state colour; `tag`: a tinted tag. */
  readonly variant?: 'text' | 'tag';
}): JSX.Element {
  const e = StateEncoding[p.state];
  const tag = p.variant === 'tag';
  return (
    <span
      className={cx(styles['stateGlyph'], tag && styles['tag'], e.className, p.className)}
      data-state={p.state}
    >
      <span aria-hidden="true" className={tag ? cx(styles['tagGlyph']) : undefined}>
        {e.glyph}
      </span>{' '}
      {tag ? <span className={cx(styles['tagLabel'])}>{t(e.label)}</span> : t(e.label)}
    </span>
  );
}
