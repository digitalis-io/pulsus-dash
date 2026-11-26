/**
 * The board's filters for its panels (plan #173 Part 3b §3.1; T22-007): the `f=` pairs in URL order
 * and the board's `setFilter` (a push; `'url.tooLong'` refuses without navigating). `BoardPage`
 * provides it from `useBoardParams`; null outside a board (the gallery, Explore).
 */
import { createContext } from 'react';
import type { BoardFilter, ParamError } from '../state/boardParams';

export interface BoardFilters {
  readonly filters: readonly BoardFilter[];
  readonly setFilter: (key: string, value: string | null) => ParamError | null;
}

export const BoardFiltersContext = createContext<BoardFilters | null>(null);
