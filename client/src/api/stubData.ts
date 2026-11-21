import type { PromMetricMetadata } from '../data/decode';
import type { StubSeed } from './StubApi';

/** The seed `npm run dev` and the tests use (generic names only). */
export const defaultSeed: StubSeed = {
  session: {
    user: { id: 'u-ada', name: 'Ada Admin', email: 'ada@example.com', role: 'admin' },
    org: { name: 'Demo Org' },
    tenants: [
      { slug: 'demo', name: 'Demo', dataSource: { state: 'notChecked' } },
      { slug: 'sandbox', name: 'Sandbox', dataSource: { state: 'notChecked' } },
    ],
    defaultTenant: 'demo',
    server: null,
    canSignOut: true,
  },
  boards: {
    demo: [
      { uid: 'b-1', title: 'Service overview', updatedAt: '2026-11-18T09:30:00.000Z' },
      { uid: 'b-2', title: 'Checkout latency', updatedAt: '2026-11-17T16:05:00.000Z' },
      {
        uid: 'b-3',
        title: 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy',
        updatedAt: '2026-11-16T08:00:00.000Z',
      },
    ],
    sandbox: [],
  },
};

/** Starred boards seeded for a tenant when its stub key is absent. */
export const defaultStarred: Readonly<Record<string, readonly string[]>> = { demo: ['b-1'] };

/** Completion metadata: the body of the e2e `metadata` transcript (plan #63 A.1, A.3). */
export const STUB_PROM_METADATA: Readonly<Record<string, readonly PromMetricMetadata[]>> = {
  http_requests_total: [{ type: 'counter', help: 'Total HTTP requests.', unit: '' }],
  http_request_duration_seconds: [
    { type: 'histogram', help: 'HTTP request duration.', unit: 'seconds' },
  ],
  node_memory_free_bytes: [{ type: 'gauge', help: 'Free memory in bytes.', unit: 'bytes' }],
  up: [{ type: 'gauge', help: 'Target up.', unit: '' }],
};

/** The values of `__name__`. */
export const STUB_PROM_METRIC_NAMES: readonly string[] = [
  'http_request_duration_seconds_bucket',
  'http_requests_total',
  'node_memory_free_bytes',
  'stub_metric',
  'up',
];

/** The values of any other label. */
export const STUB_PROM_LABEL_VALUES: readonly string[] = ['a', 'b'];

export const STUB_PROM_LABELS: readonly string[] = ['__name__', 'instance', 'job', 'le', 'series'];
