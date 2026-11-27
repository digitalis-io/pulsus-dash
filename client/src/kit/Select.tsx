/**
 * A select (T08-007, T08-008): React Aria's `Select` with a button trigger, a popover and a list
 * box. React Aria names the trigger by its value, then its label (e.g. `Stat Visualisation`).
 * Options with a `group` are shown in sections under that header (consecutive options of one group
 * are one section, `role="group"` named by it); the keyboard skips the headers.
 */
import {
  Button as AriaButton,
  FieldError,
  Header,
  Label,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Select as AriaSelect,
  SelectValue,
  type Key,
} from 'react-aria-components';
import { Icon } from './Icon';
import { Popover } from './Popover';
import styles from './Select.module.css';
import { cx } from './cx';

export interface SelectOption<K extends string> {
  id: K;
  label: string;
  /** Shown but not selectable (e.g. a stored kind this version does not draw). */
  disabled?: boolean;
  /** The header of the option's section; consecutive options of one group share it. */
  group?: string;
}

interface Section<K extends string> {
  readonly group: string | undefined;
  readonly options: SelectOption<K>[];
}

/** `options` cut where the group changes, in order. */
function sectionsOf<K extends string>(options: readonly SelectOption<K>[]): Section<K>[] {
  const out: Section<K>[] = [];
  for (const o of options) {
    const last = out.at(-1);
    if (last !== undefined && last.group === o.group) last.options.push(o);
    else out.push({ group: o.group, options: [o] });
  }
  return out;
}

export interface SelectProps<K extends string> {
  label: string;
  value: K;
  options: readonly SelectOption<K>[];
  onChange: (value: K) => void;
  isDisabled?: boolean;
  /** Shown, and linked by aria-describedby, when set (T08-008). */
  error?: string | null;
}

export function Select<K extends string>({
  label,
  value,
  options,
  onChange,
  isDisabled = false,
  error,
}: SelectProps<K>) {
  const invalid = error !== null && error !== undefined;
  const item = (o: SelectOption<K>) => (
    <ListBoxItem key={o.id} id={o.id} textValue={o.label} className={cx(styles['option'])}>
      {o.label}
    </ListBoxItem>
  );
  const onSelect = (key: Key | null): void => {
    const option = options.find((o) => o.id === key);
    if (option !== undefined) onChange(option.id);
  };
  return (
    <AriaSelect
      value={value}
      onChange={onSelect}
      disabledKeys={options.filter((o) => o.disabled === true).map((o) => o.id)}
      isDisabled={isDisabled}
      isInvalid={invalid}
      validationBehavior="aria"
      className={cx(styles['field'])}
    >
      <Label className={cx(styles['label'])}>{label}</Label>
      <AriaButton className={cx(styles['trigger'])}>
        <SelectValue className={cx(styles['value'])} />
        <Icon name="chevron-down" />
      </AriaButton>
      <FieldError className={cx(styles['error'])}>{error}</FieldError>
      <Popover placement="bottom start" className={cx(styles['popover'])}>
        <ListBox className={cx(styles['list'])}>
          {sectionsOf(options).map((sec, i) =>
            sec.group === undefined ? (
              sec.options.map(item)
            ) : (
              <ListBoxSection key={`${String(i)}|${sec.group}`} className={cx(styles['section'])}>
                <Header className={cx(styles['header'])}>{sec.group}</Header>
                {sec.options.map(item)}
              </ListBoxSection>
            ),
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
