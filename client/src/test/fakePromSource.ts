/**
 * `PromSource`s for the editor tests (plan #63 Part B, B.3; plan #107 §3.8): `fakePromSource`
 * resolves fixed data at once and records its calls (it accepts and ignores a lookup's signal);
 * `pendingPromSource` holds every lookup until the test releases it, and settles `[]` as soon as
 * the lookup's signal aborts. Used in place of `createPromSource`.
 */
import type { PromSource } from '../editor/lang/types';

export interface FakePromData {
  readonly names?: readonly string[];
  readonly labels?: readonly string[];
  readonly values?: readonly string[];
  readonly series?: readonly Readonly<Record<string, string>>[];
  readonly metadata?: Readonly<
    Record<string, readonly { readonly type: string; readonly help: string }[]>
  >;
}

export interface FakePromSource extends PromSource {
  /** `'metricNames'`, `'labelNames <m|null>'`, `'labelValues <name> <m|null>'`, `'series <m>'`, `'metadata'`. */
  readonly calls: string[];
}

/** The data of the editor tests (B.3 `F`). */
export const F: FakePromData = {
  names: ['http_requests_total', 'up'],
  labels: ['instance', 'job'],
  values: ['api'],
  series: [{ job: 'a' }],
  metadata: { http_requests_total: [{ type: 'counter', help: 'Total HTTP requests.' }] },
};

/** Mid-token rows (#107): values `checkout`, `web`; labels `app`, `instance`, `job`. */
export const FM: FakePromData = {
  ...F,
  labels: ['app', 'instance', 'job'],
  values: ['checkout', 'web'],
};
/** A value with a double quote. */
export const FQ: FakePromData = { ...F, values: ['a"b'] };
/** T09-008 rows: two metrics that share a prefix no static item matches; two values. */
export const FH: FakePromData = { ...F, names: ['http_a', 'http_b', 'up'], values: ['a1', 'a2'] };

/** Resolves the given data (default `[]` and `{}`), copied on every call. */
export function fakePromSource(d: FakePromData = {}): FakePromSource {
  const calls: string[] = [];
  return {
    calls,
    metricNames: () => {
      calls.push('metricNames');
      return Promise.resolve([...(d.names ?? [])]);
    },
    labelNames: (m) => {
      calls.push(`labelNames ${m ?? 'null'}`);
      return Promise.resolve([...(d.labels ?? [])]);
    },
    labelValues: (name, m) => {
      calls.push(`labelValues ${name} ${m ?? 'null'}`);
      return Promise.resolve([...(d.values ?? [])]);
    },
    series: (m) => {
      calls.push(`series ${m}`);
      return Promise.resolve((d.series ?? []).map((s) => ({ ...s })));
    },
    metadata: () => {
      calls.push('metadata');
      return Promise.resolve(structuredClone(d.metadata ?? {}));
    },
  };
}

export interface HeldPromCall {
  /** As `FakePromSource.calls` writes it, e.g. `'labelValues job up'`, `'metricNames'`. */
  readonly call: string;
  readonly signal: AbortSignal;
  /** Settles the call with `values` (no-op once settled). */
  release(values: readonly string[]): void;
}

export interface PendingPromSource {
  readonly source: PromSource;
  readonly held: HeldPromCall[];
}

/**
 * Every lookup is held until `release` and settles `[]` as soon as its signal aborts. A lookup
 * without a signal throws. `metadata()` resolves `{}` at once.
 */
export function pendingPromSource(): PendingPromSource {
  const held: HeldPromCall[] = [];
  const hold = <T>(
    call: string,
    signal: AbortSignal | undefined,
    of: (values: readonly string[]) => T,
  ): Promise<T> => {
    if (signal === undefined) throw new Error(`${call} called without a signal`);
    return new Promise<T>((resolve) => {
      let done = false;
      const settle = (v: readonly string[]) => {
        if (done) return;
        done = true;
        resolve(of(v));
      };
      signal.addEventListener(
        'abort',
        () => {
          settle([]);
        },
        { once: true },
      );
      held.push({ call, signal, release: settle });
    });
  };
  const list = (v: readonly string[]) => [...v];
  return {
    held,
    source: {
      metricNames: (signal) => hold('metricNames', signal, list),
      labelNames: (m, signal) => hold(`labelNames ${m ?? 'null'}`, signal, list),
      labelValues: (name, m, signal) => hold(`labelValues ${name} ${m ?? 'null'}`, signal, list),
      series: (m, signal) => hold(`series ${m}`, signal, (v) => v.map((x) => ({ value: x }))),
      metadata: () => Promise.resolve({}),
    },
  };
}
