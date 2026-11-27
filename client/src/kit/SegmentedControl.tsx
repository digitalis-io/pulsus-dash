/**
 * A single-choice segmented control (plan #63 Part C §3.4): React Aria's `ToggleButtonGroup` with
 * single selection, which renders a `radiogroup` of `radio`s; the arrow keys move between options
 * (one tab stop) and the selected option cannot be deselected. A `null` value selects nothing (the
 * header's quick ranges while the range is another, #282 Part 2a); `ariaLabel` names an option whose
 * label is short. One thumb slides (transform only) to the selected option; until it is placed (and
 * in tests, where nothing has a layout), the selected option draws its own fill.
 */
import { useLayoutEffect, useRef, type JSX } from 'react';
import { ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components';
import styles from './SegmentedControl.module.css';
import { cx } from './cx';

export interface SegmentedOption<K extends string> {
  readonly id: K;
  readonly label: string;
  /** The option's accessible name, when its visible label is an abbreviation. */
  readonly ariaLabel?: string;
}

export interface SegmentedControlProps<K extends string> {
  readonly label: string;
  readonly options: readonly SegmentedOption<K>[];
  /** The selected option; null selects none. */
  readonly value: K | null;
  readonly onChange: (v: K) => void;
  /** Shown but not operable (a read-only editor). */
  readonly isDisabled?: boolean;
  /** `toolbar`: no track of its own, inside a toolbar's track (the header's time group). */
  readonly tone?: SegmentedTone;
}

export type SegmentedTone = 'default' | 'toolbar';

/**
 * Slides the thumb from the last selected option to the current one: FLIP on transform, through
 * `--thumb-x` (px), `--thumb-w` (px) and `--thumb-from` (the start scale).
 */
function useThumb(value: string | null) {
  const group = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLSpanElement>(null);
  const last = useRef<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const root = group.current;
    const mark = thumb.current;
    if (root === null || mark === null) return;
    const item = value === null ? null : root.querySelector<HTMLElement>('[data-selected]');
    if (item === null || item.offsetWidth === 0) {
      delete root.dataset['thumb'];
      last.current = null;
      return;
    }
    const next = { x: item.offsetLeft, w: item.offsetWidth };
    const prev = last.current;
    mark.style.setProperty('--thumb-w', String(next.w));
    if (prev !== null && (prev.x !== next.x || prev.w !== next.w)) {
      mark.dataset['flip'] = '';
      mark.style.setProperty('--thumb-x', String(prev.x));
      mark.style.setProperty('--thumb-from', String(prev.w / next.w));
      // Commit the start state before the transition to the end state.
      mark.getBoundingClientRect();
      delete mark.dataset['flip'];
    }
    mark.style.setProperty('--thumb-x', String(next.x));
    mark.style.setProperty('--thumb-from', '1');
    root.dataset['thumb'] = '';
    last.current = next;
  });
  return { group, thumb };
}

export function SegmentedControl<K extends string>({
  label,
  options,
  value,
  onChange,
  isDisabled = false,
  tone = 'default',
}: SegmentedControlProps<K>): JSX.Element {
  const ids = options.map((o) => o.id);
  const { group: groupRef, thumb: thumbRef } = useThumb(value);
  return (
    <ToggleButtonGroup
      ref={groupRef}
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      isDisabled={isDisabled}
      selectedKeys={value === null ? [] : [value]}
      onSelectionChange={(s: Set<Key>) => {
        const next = ids.find((id) => s.has(id));
        if (next !== undefined && next !== value) onChange(next);
      }}
      className={cx(styles['group'], tone === 'toolbar' ? styles['toolbar'] : undefined)}
    >
      <span ref={thumbRef} className={cx(styles['thumb'])} aria-hidden="true" />
      {options.map((o) => (
        <ToggleButton
          key={o.id}
          id={o.id}
          className={cx(styles['item'])}
          {...(o.ariaLabel === undefined ? {} : { 'aria-label': o.ariaLabel })}
        >
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
