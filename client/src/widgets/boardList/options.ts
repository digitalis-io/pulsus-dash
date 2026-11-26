/** A board list's options (plan #216 Part 1 §3.6; T24 §5.5). */
import type { BoardListMode, VisOptions } from '../../api/types';
import { OPTION_VALUES } from '../../boards/options';

export interface BoardListOptions {
  readonly mode: BoardListMode;
  readonly query: string;
  readonly tag: string | null;
  readonly limit: number;
  readonly sort: 'default' | 'incidents';
}

/** The default rows of a board list. */
export const DEFAULT_BOARD_LIMIT = 10;

function isMode(v: unknown): v is BoardListMode {
  return (OPTION_VALUES.boardListMode as readonly unknown[]).includes(v);
}

/**
 * A board list's options with the T24 §5.5 defaults: starred, `''`, no tag, 10 rows, the default
 * order. A shared key holding another kind's value (the validator refuses it) reads as the default.
 */
export function boardListOptions(o?: VisOptions): BoardListOptions {
  return {
    mode: isMode(o?.mode) ? o.mode : 'starred',
    query: o?.query ?? '',
    tag: o?.tag ?? null,
    limit: o?.limit ?? DEFAULT_BOARD_LIMIT,
    sort: o?.sort === 'incidents' ? 'incidents' : 'default',
  };
}
