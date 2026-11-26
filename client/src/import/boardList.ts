/** Board list import (stub). */
import { boardListOptions, type BoardListOptions } from '../widgets/boardList/options';

export function importBoardList(_src: Readonly<Record<string, unknown>>): {
  readonly options: BoardListOptions;
  readonly notes: readonly string[];
} {
  return { options: boardListOptions(), notes: [] };
}
