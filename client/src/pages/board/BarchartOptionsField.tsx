/**
 * The bar chart's options in the panel editor (T22 §6.1; plan #173 Part 3a §3.9): reducer, category
 * label, sort, orientation, value labels, min, max and the baseline offset, each writing its own
 * key of `vis.options` and showing the T22 defaults when the key is absent. A field set back to its
 * empty state removes its key; no key left gives `undefined`. Min and Max write only a finite
 * number, and say so under the field otherwise; `errorAt(key)` (the spec validator's message) shows
 * under its field. #173 Part 3b mounts it in the editor.
 */
import { useState, type JSX } from 'react';
import type { VisOptions } from '../../api/types';
import { barchartOptions, OPTION_VALUES, type OptionKey } from '../../boards/options';
import type { MessageId } from '../../i18n/messages.en-GB';
import { t } from '../../i18n/t';
import { Checkbox } from '../../kit/Checkbox';
import { cx } from '../../kit/cx';
import { SegmentedControl } from '../../kit/SegmentedControl';
import { Select } from '../../kit/Select';
import { TextField } from '../../kit/TextField';
import styles from './Board.module.css';

export interface BarchartOptionsFieldProps {
  readonly options: VisOptions | undefined;
  readonly errorAt: (key: OptionKey) => string | null;
  readonly readOnly: boolean;
  readonly onChange: (o: VisOptions | undefined) => void;
}

type Offset = NonNullable<VisOptions['baselineOffset']>;
const NO_OFFSET = 'none';

/** `o` with `key` set to `v`, or removed for undefined; undefined when no key is left. */
function withKey<K extends OptionKey>(
  o: VisOptions | undefined,
  key: K,
  v: VisOptions[K] | undefined,
): VisOptions | undefined {
  const next = Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => k !== key));
  if (v !== undefined) next[key] = v;
  return Object.keys(next).length === 0 ? undefined : next;
}

/** The text of a bound: `''` for absent. */
const boundText = (v: number | undefined): string => (v === undefined ? '' : String(v));

/** A Min or Max field: `''` removes the key, a finite number writes it, anything else says so. */
function BoundField(p: {
  readonly name: 'min' | 'max';
  readonly value: number | undefined;
  readonly error: string | null;
  readonly readOnly: boolean;
  readonly onWrite: (v: number | undefined) => void;
}): JSX.Element {
  const [text, setText] = useState(() => boundText(p.value));
  const [seen, setSeen] = useState(p.value);
  // A new stored value (another field, a kind change) replaces the text (React's "adjust state
  // during render").
  if (seen !== p.value) {
    setSeen(p.value);
    if (Number(text) !== p.value || text.trim() === '') setText(boundText(p.value));
  }
  const trimmed = text.trim();
  const n = Number(trimmed);
  const bad = trimmed !== '' && !Number.isFinite(n);
  return (
    <TextField
      label={t(`editor.options.${p.name}`)}
      value={text}
      isReadOnly={p.readOnly}
      inputMode="decimal"
      error={bad ? t('editor.options.number') : p.error}
      onChange={(s) => {
        setText(s);
        const v = s.trim();
        if (v === '') p.onWrite(undefined);
        else if (Number.isFinite(Number(v))) p.onWrite(Number(v));
      }}
    />
  );
}

function FieldError({ error }: { readonly error: string | null }): JSX.Element | null {
  return error === null ? null : <p className={cx(styles['optionsError'])}>{error}</p>;
}

export function BarchartOptionsField(p: BarchartOptionsFieldProps): JSX.Element {
  const b = barchartOptions(p.options);
  const set = <K extends OptionKey>(key: K, v: VisOptions[K] | undefined): void => {
    p.onChange(withKey(p.options, key, v));
  };
  const [label, setLabel] = useState(b.categoryBy);
  const [seenLabel, setSeenLabel] = useState(b.categoryBy);
  if (seenLabel !== b.categoryBy) {
    setSeenLabel(b.categoryBy);
    if (label.trim() !== b.categoryBy) setLabel(b.categoryBy);
  }
  const option = <V extends string>(group: string, id: V) => ({
    id,
    label: t(`editor.options.${group}.${id}` as MessageId),
  });
  return (
    <fieldset className={cx(styles['options'])} data-barchart-options="">
      <Select
        label={t('editor.options.reducer')}
        value={b.reducer}
        options={OPTION_VALUES.reducer.map((id) => option('reducer', id))}
        onChange={(v) => {
          set('reducer', v);
        }}
        error={p.errorAt('reducer')}
        isDisabled={p.readOnly}
      />
      <TextField
        label={t('editor.options.categoryBy')}
        placeholder={t('editor.options.categoryBy.auto')}
        value={label}
        isReadOnly={p.readOnly}
        mono
        error={p.errorAt('categoryBy')}
        onChange={(s) => {
          setLabel(s);
          const v = s.trim();
          setSeenLabel(v);
          set('categoryBy', v === '' ? undefined : v);
        }}
      />
      <Select
        label={t('editor.options.sort')}
        value={b.sort}
        options={OPTION_VALUES.sort.map((id) => option('sort', id))}
        onChange={(v) => {
          set('sort', v);
        }}
        error={p.errorAt('sort')}
        isDisabled={p.readOnly}
      />
      <div>
        <SegmentedControl
          label={t('editor.options.orientation')}
          options={OPTION_VALUES.orientation.map((id) => option('orientation', id))}
          value={b.orientation}
          onChange={(v) => {
            set('orientation', v);
          }}
          isDisabled={p.readOnly}
        />
        <FieldError error={p.errorAt('orientation')} />
      </div>
      <div>
        <Checkbox
          isSelected={b.valueLabels}
          isDisabled={p.readOnly}
          onChange={(on) => {
            set('valueLabels', on);
          }}
        >
          {t('editor.options.valueLabels')}
        </Checkbox>
        <FieldError error={p.errorAt('valueLabels')} />
      </div>
      <Select<Offset | typeof NO_OFFSET>
        label={t('editor.options.baselineOffset')}
        value={b.baselineOffset ?? NO_OFFSET}
        options={[
          { id: NO_OFFSET, label: t('editor.options.baselineOffset.none') },
          ...OPTION_VALUES.baselineOffset.map((id) => option('baselineOffset', id)),
        ]}
        onChange={(v) => {
          set('baselineOffset', v === NO_OFFSET ? undefined : v);
        }}
        error={p.errorAt('baselineOffset')}
        isDisabled={p.readOnly}
      />
      <BoundField
        name="min"
        value={b.min}
        error={p.errorAt('min')}
        readOnly={p.readOnly}
        onWrite={(v) => {
          set('min', v);
        }}
      />
      <BoundField
        name="max"
        value={b.max}
        error={p.errorAt('max')}
        readOnly={p.readOnly}
        onWrite={(v) => {
          set('max', v);
        }}
      />
    </fieldset>
  );
}
