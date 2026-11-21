/** A multi-line text field (T08-007, T08-008): React Aria's `TextField` with a `TextArea`. */
import {
  FieldError,
  Label,
  TextArea as AriaTextArea,
  TextField as AriaTextField,
  type TextFieldProps as AriaTextFieldProps,
} from 'react-aria-components';
import styles from './TextArea.module.css';
import { cx } from './cx';

export interface TextAreaProps extends Omit<AriaTextFieldProps, 'className' | 'children'> {
  label: string;
  /** Shown, and linked by aria-describedby, when set (T08-008). */
  error?: string | null;
  mono?: boolean;
  rows?: number;
}

export function TextArea({ label, error, mono = false, rows = 3, ...props }: TextAreaProps) {
  const invalid = error !== null && error !== undefined;
  return (
    <AriaTextField
      {...props}
      isInvalid={invalid}
      validationBehavior="aria"
      className={cx(styles['field'])}
    >
      <Label className={cx(styles['label'])}>{label}</Label>
      <AriaTextArea
        rows={rows}
        className={cx(styles['input'], mono ? styles['mono'] : undefined)}
      />
      <FieldError className={cx(styles['error'])}>{error}</FieldError>
    </AriaTextField>
  );
}
