/** The bar chart's options (plan #173 Part 3a §3.9). Stub (tests first). */
import type { JSX } from 'react';
import type { VisOptions } from '../../api/types';
import type { OptionKey } from '../../boards/options';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function BarchartOptionsField(p: {
  options: VisOptions | undefined;
  errorAt: (key: OptionKey) => string | null;
  readOnly: boolean;
  onChange: (o: VisOptions | undefined) => void;
}): JSX.Element {
  return <div />;
}
