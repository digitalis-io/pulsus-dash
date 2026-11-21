/** Stub (plan #65 Part B §3.5). */
export const LOG_LEVELS = ['unknown', 'trace', 'debug', 'info', 'warn', 'error', 'critical'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export interface LogStreamInfo {
  readonly key: string;
  readonly labels: Readonly<Record<string, string>>;
}
export interface LogFrame {
  readonly direction: 'backward' | 'forward';
  readonly streams: readonly LogStreamInfo[];
  readonly tsNs: BigInt64Array;
  readonly streamIndex: Uint32Array;
  readonly lines: readonly string[];
  readonly levels: Uint8Array;
  readonly metadata: readonly (Readonly<Record<string, string>> | null)[];
  readonly parsed: readonly (Readonly<Record<string, string>> | null)[];
}
