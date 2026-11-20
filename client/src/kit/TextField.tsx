import {
  FieldError,
  Input,
  Label,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import type { Ref } from 'react';
import styles from './TextField.module.css';
import { cx } from './cx';

export interface TextFieldProps extends Omit<AriaTextFieldProps, 'className' | 'children'> {
  label: string;
  /** Shown, and linked by aria-describedby, when set (T08-008). */
  error?: string | null;
  mono?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export function TextField({ label, error, mono = false, inputRef, ...props }: TextFieldProps) {
  const invalid = error !== null && error !== undefined;
  return (
    <AriaTextField
      {...props}
      isInvalid={invalid}
      validationBehavior="aria"
      className={cx(styles['field'])}
    >
      <Label className={cx(styles['label'])}>{label}</Label>
      <Input ref={inputRef} className={cx(styles['input'], mono ? styles['mono'] : undefined)} />
      <FieldError className={cx(styles['error'])}>{error}</FieldError>
    </AriaTextField>
  );
}
