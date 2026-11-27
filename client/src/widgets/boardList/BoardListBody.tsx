/** Stub (tests first, plan #216 Part 2a). */
/* eslint-disable @typescript-eslint/no-unused-vars -- a stub */
import type { WidgetPanelSpec } from '../../api/types';

export interface BoardListBodyProps {
  panel: WidgetPanelSpec;
  headingId: string;
  editing: boolean;
  table: boolean;
  onTable: (on: boolean) => void;
}

export function BoardListBody(_p: BoardListBodyProps) {
  return null;
}
