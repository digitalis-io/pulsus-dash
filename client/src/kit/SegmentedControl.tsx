/**
 * A single-choice segmented control (plan #63 Part C §3.4): React Aria's `ToggleButtonGroup` with
 * single selection, which renders a `radiogroup` of `radio`s; the arrow keys move between options
 * (one tab stop) and the selected option cannot be deselected.
 */
import type { JSX } from 'react';
import { ToggleButton, ToggleButtonGroup, type Key } from 'react-aria-components';
import styles from './SegmentedControl.module.css';
import { cx } from './cx';

export interface SegmentedOption<K extends string> {
  readonly id: K;
  readonly label: string;
}

export interface SegmentedControlProps<K extends string> {
  readonly label: string;
  readonly options: readonly SegmentedOption<K>[];
  readonly value: K;
  readonly onChange: (v: K) => void;
  /** Shown but not operable (a read-only editor). */
  readonly isDisabled?: boolean;
}

export function SegmentedControl<K extends string>({
  label,
  options,
  value,
  onChange,
  isDisabled = false,
}: SegmentedControlProps<K>): JSX.Element {
  const ids = options.map((o) => o.id);
  return (
    <ToggleButtonGroup
      aria-label={label}
      selectionMode="single"
      disallowEmptySelection
      isDisabled={isDisabled}
      selectedKeys={[value]}
      onSelectionChange={(s: Set<Key>) => {
        const next = ids.find((id) => s.has(id));
        if (next !== undefined && next !== value) onChange(next);
      }}
      className={cx(styles['group'])}
    >
      {options.map((o) => (
        <ToggleButton key={o.id} id={o.id} className={cx(styles['item'])}>
          {o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
