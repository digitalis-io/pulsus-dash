/** Board list facts (stub). */
import type { BoardListMode } from '../../api/types';
import type { SummaryFacts } from '../../engine/api';
import type { ListSnapshot } from '../lists/snapshot';
import type { BoardRow } from './rows';

export function boardListFacts(
  _title: string,
  _mode: BoardListMode,
  _s: ListSnapshot<BoardRow> | null,
): SummaryFacts | null {
  return null;
}
