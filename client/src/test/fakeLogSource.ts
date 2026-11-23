/**
 * `LogSource`s for the LogQL editor tests (plan #66 Part A, A.4): `fakeLogSource` resolves fixed
 * data at once; `pendingLogSource` holds every call until the test releases it, and settles `[]`
 * as soon as the call's signal aborts. Both record their calls.
 */
import type { LogSource } from '../editor/lang/types';

export interface FakeLogData {
  readonly labels?: readonly string[];
  readonly values?: readonly string[];
}

export interface FakeLogSource extends LogSource {
  /** `'labelNames <sel|null>'`, `'labelValues <name> <sel|null>'`. */
  readonly calls: string[];
}

/** A.4 `FL`. */
export const FL: FakeLogData = { labels: ['app', 'pod'], values: ['checkout', 'web'] };
/** A.4 `FL2`: values with a double quote and a backtick. */
export const FL2: FakeLogData = { values: ['a"b', 'x`y'] };

/** Resolves the given data (default `[]`), copied on every call. */
export function fakeLogSource(d: FakeLogData = {}): FakeLogSource {
  const calls: string[] = [];
  return {
    calls,
    labelNames: (selector) => {
      calls.push(`labelNames ${selector ?? 'null'}`);
      return Promise.resolve([...(d.labels ?? [])]);
    },
    labelValues: (name, selector) => {
      calls.push(`labelValues ${name} ${selector ?? 'null'}`);
      return Promise.resolve([...(d.values ?? [])]);
    },
  };
}

export interface HeldLogCall {
  readonly method: 'labelNames' | 'labelValues';
  readonly name: string | null;
  readonly selector: string | null;
  readonly signal: AbortSignal;
  /** Settles the call with `values` (no-op once settled). */
  release(values: readonly string[]): void;
}

export interface PendingLogSource {
  readonly source: LogSource;
  readonly held: HeldLogCall[];
}

/** Every call is held until `release`; an abort of its signal settles it `[]` at once. */
export function pendingLogSource(): PendingLogSource {
  const held: HeldLogCall[] = [];
  const hold = (
    method: HeldLogCall['method'],
    name: string | null,
    selector: string | null,
    signal: AbortSignal | undefined,
  ): Promise<readonly string[]> => {
    if (signal === undefined) throw new Error(`${method} called without a signal`);
    return new Promise((resolve) => {
      let done = false;
      const settle = (v: readonly string[]) => {
        if (done) return;
        done = true;
        resolve(v);
      };
      signal.addEventListener(
        'abort',
        () => {
          settle([]);
        },
        { once: true },
      );
      held.push({ method, name, selector, signal, release: settle });
    });
  };
  return {
    held,
    source: {
      labelNames: (selector, signal) => hold('labelNames', null, selector, signal),
      labelValues: (name, selector, signal) => hold('labelValues', name, selector, signal),
    },
  };
}
