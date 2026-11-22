/**
 * A `PromSource` of fixed data that records its calls (plan #63 Part B, B.3). Used by the editor
 * tests in place of `createPromSource`.
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
