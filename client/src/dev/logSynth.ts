/** The synthetic log API (plan #66 Part B, B.1). Stub: implemented in the next commit. */
import type { Api } from '../api/Api';
import type { LogsRequest } from '../api/types';

export interface SynthEntry {
  readonly tsNs: bigint;
  readonly labels: Readonly<Record<string, string>>;
  readonly line: string;
}
export interface SynthLogOptions {
  readonly entries?: readonly SynthEntry[];
  readonly total?: number;
  readonly groupOf?: (g: number) => number;
  readonly lineLength?: number;
  readonly latencyMs?: number;
}
export interface SynthLogApi extends Pick<Api, 'queryLogs'> {
  latencyMs: number;
  readonly calls: readonly LogsRequest[];
  insert(e: SynthEntry): void;
  replace(tsNs: bigint, line: string, withLine: string): void;
}

export function createSynthLogApi(o: SynthLogOptions): SynthLogApi {
  void o;
  throw new Error('not implemented');
}
export function synthCursor(c: { tsNs: bigint; skip: number }): string {
  void c;
  throw new Error('not implemented');
}
export function parseSynthCursor(c: string): { tsNs: bigint; skip: number } {
  void c;
  throw new Error('not implemented');
}
