/** Stub (tests first): plan #198 Part 3a §3.1. */
import type { ReactElement } from 'react';
import type { TextOptions } from '../spec';

export function TextContent(_p: {
  panelId: string;
  options: TextOptions;
  vars: ReadonlyMap<string, string>;
}): ReactElement {
  return <div />;
}

export function TextRemovals(_p: {
  options: TextOptions;
  vars: ReadonlyMap<string, string>;
}): ReactElement | null {
  return null;
}
