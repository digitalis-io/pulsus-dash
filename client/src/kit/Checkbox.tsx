// Stub for the tests-first commit: the implementation follows.
import { type CheckboxFieldProps } from 'react-aria-components';

import type { ReactNode } from 'react';

export function Checkbox({
  children,
  ...props
}: Omit<CheckboxFieldProps, 'className' | 'children'> & {
  children: ReactNode;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}
