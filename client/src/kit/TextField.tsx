// Stub for the tests-first commit: the implementation follows.
import { type TextFieldProps as AriaTextFieldProps } from 'react-aria-components';

import type { Ref } from 'react';

export interface TextFieldProps extends Omit<AriaTextFieldProps, 'className' | 'children'> {
  label: string;
  /** Shown, and linked by aria-describedby, when set (T08-008). */
  error?: string | null;
  mono?: boolean;
  inputRef?: Ref<HTMLInputElement>;
}

export function TextField({
  label,
  error,
  mono,
  inputRef,
  ...props
}: TextFieldProps): import('react').JSX.Element {
  throw new Error('not implemented');
}
