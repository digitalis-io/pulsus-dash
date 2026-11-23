/**
 * A `queryLogs` whose answers the test settles (plan #66 Part B §2): each call is recorded with
 * its tenant, request and signal, and returns a deferred; `resolve(i, …)` and `reject(i, …)`
 * settle call `i`. An abort does not settle a call by itself.
 */
import type { Api } from '../api/Api';
import type { LogsRequest } from '../api/types';
import type { LogsResult } from '../data/decode';

export interface ScriptedCall {
  readonly tenant: string;
  readonly req: LogsRequest;
  readonly signal: AbortSignal | undefined;
}

export interface ScriptedLogsApi extends Pick<Api, 'queryLogs'> {
  readonly calls: readonly ScriptedCall[];
  resolve(i: number, result: LogsResult): Promise<void>;
  reject(i: number, err: unknown): Promise<void>;
}

interface Deferred {
  resolve: (r: LogsResult) => void;
  reject: (e: unknown) => void;
  promise: Promise<LogsResult>;
}

export function scriptedLogsApi(): ScriptedLogsApi {
  const calls: ScriptedCall[] = [];
  const pending: Deferred[] = [];
  const at = (i: number): Deferred => {
    const d = pending[i];
    if (d === undefined) throw new Error(`no call ${String(i)} (${String(pending.length)} made)`);
    return d;
  };
  // Settling resolves after the pager's handler has run (two microtask turns and a macrotask).
  const flush = (d: Deferred): Promise<void> =>
    d.promise.then(
      () => new Promise((r) => setTimeout(r, 0)),
      () => new Promise((r) => setTimeout(r, 0)),
    );
  return {
    calls,
    queryLogs(tenant, req, signal) {
      calls.push({ tenant, req, signal });
      let resolve!: (r: LogsResult) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<LogsResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending.push({ resolve, reject, promise });
      return promise;
    },
    resolve(i, result) {
      const d = at(i);
      d.resolve(result);
      return flush(d);
    },
    reject(i, err) {
      const d = at(i);
      d.reject(err);
      return flush(d);
    },
  };
}
