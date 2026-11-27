/** Stub (tests first, plan #216 Part 2b §3.1). */
import type { WidgetPanelSpec } from '../../api/types';
import type { BoardListOptions } from './options';

export function boardListVis(
  _o: BoardListOptions,
  _original: WidgetPanelSpec['vis'] | undefined,
): WidgetPanelSpec['vis'] {
  return { kind: 'boardList', options: {} };
}
