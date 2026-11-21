/**
 * The decoded log page (plan #65 Part B §3.5): the JSON image of T04 `log_lines/1` as columns.
 * Rows are in request direction; timestamps are exact `BigInt` nanoseconds (a double cannot
 * hold a nanosecond epoch), and levels are T04 level codes.
 */

/** The T04 level names; a level code is its index (0 `unknown` … 6 `critical`). */
export const LOG_LEVELS = [
  'unknown',
  'trace',
  'debug',
  'info',
  'warn',
  'error',
  'critical',
] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** One stream of a page: its key (16 hex digits) and its indexed stream labels. */
export interface LogStreamInfo {
  readonly key: string;
  readonly labels: Readonly<Record<string, string>>;
}

export interface LogFrame {
  readonly direction: 'backward' | 'forward';
  /** The page's streams, in key order (the BFF's order). */
  readonly streams: readonly LogStreamInfo[];
  /** Rows in request direction (T04 log_lines/1): ns since the epoch, exact. */
  readonly tsNs: BigInt64Array;
  /** Per row: an index into `streams`. */
  readonly streamIndex: Uint32Array;
  readonly lines: readonly string[];
  /** Per row: an index into `LOG_LEVELS`. */
  readonly levels: Uint8Array;
  /** Per row: the structured metadata, or null if the row has none. */
  readonly metadata: readonly (Readonly<Record<string, string>> | null)[];
  /** Per row: the parsed fields, or null if the row has none. */
  readonly parsed: readonly (Readonly<Record<string, string>> | null)[];
}
