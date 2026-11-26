/** The table view (plan #173 Part 3a §3.7). Stub (tests first). */
import type { JSX } from 'react';
import type { PanelRows } from '../vis/reduce';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function PanelTable(p: {
  rows: PanelRows;
  title: string;
  selected: ReadonlySet<string>;
  onRow?: (key: string, source: 'pointer' | 'keyboard', el: HTMLElement) => void;
  onClose: () => void;
}): JSX.Element {
  return <div />;
}
