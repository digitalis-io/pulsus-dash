/**
 * A select (T08-007, T08-008): React Aria's `Select` with a button trigger, a popover and a list
 * box. React Aria names the trigger by its value, then its label (e.g. `Stat Visualisation`).
 */
import {
  Button as AriaButton,
  FieldError,
  Label,
  ListBox,
  ListBoxItem,
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
          {options.map((o) => (
            <ListBoxItem key={o.id} id={o.id} textValue={o.label} className={cx(styles['option'])}>
              {o.label}
            </ListBoxItem>
          ))}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
