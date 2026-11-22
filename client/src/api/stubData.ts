import type { PromMetricMetadata } from '../data/decode';
import type { StubSeed } from './StubApi';
import type { PanelSpec } from './types';

function panel(
  id: string,
  title: string,
  lang: PanelSpec['query']['lang'],
  text: string,
  kind: PanelSpec['vis']['kind'],
  [x, y, w, h]: readonly [number, number, number, number],
  /** More of the panel's `vis` (thresholds, legend; #64 Part B B.9). */
  vis: Omit<PanelSpec['vis'], 'kind'> = {},
): PanelSpec {
  return { id, title, grid: { x, y, w, h }, query: { lang, text }, vis: { kind, ...vis } };
}

const EDGE_TITLE = 'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy';

/**
 * The seed `npm run dev` and the tests use (generic names only; plan #61 Part B Appendix B-A §A.1).
 * b-3's queries reference the variables `region` and `env` (Part C Appendix C-A §A.2).
 * Boards belong to the organisation, so every tenant shows the same list.
 */
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
  boards: [
    {
      uid: 'b-1',
      title: 'Service overview',
      updatedAt: '2026-11-18T09:30:00.000Z',
      spec: {
        title: 'Service overview',
        time: { from: 'now-6h', to: 'now' },
        panels: [
          panel(
            'p-1',
            'Request rate',
            'promql',
            'sum(rate(http_requests_total[5m]))',
            'line',
            [0, 0, 6, 8],
            {
              thresholds: {
                direction: 'above',
                steps: [
                  { value: 1500, state: 'watch', label: '' },
                  { value: 2500, state: 'degraded', label: 'Capacity' },
                ],
              },
            },
          ),
          panel(
            'p-2',
            'Error ratio',
            'promql',
            'sum(rate(http_requests_total{code=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))',
            'stat',
            [6, 0, 6, 8],
            {
              thresholds: {
                direction: 'above',
                steps: [
                  { value: 0.01, state: 'degraded', label: '' },
                  { value: 0.05, state: 'failing', label: 'SLO breach' },
                ],
              },
            },
          ),
          panel('p-3', 'Errors', 'logql', '{app="api"} |= "error"', 'logs', [0, 8, 12, 10]),
        ],
        sections: [
          {
            id: 's-1',
            title: 'Latency',
            collapsed: false,
            panels: [
              panel(
                'p-4',
                'Request latency',
                'promql',
                'sum(rate(http_request_duration_seconds_bucket[5m])) by (le)',
                'heatmap',
                [0, 0, 12, 8],
              ),
            ],
          },
        ],
      },
    },
    {
      uid: 'b-2',
      title: 'Checkout latency',
      updatedAt: '2026-11-17T16:05:00.000Z',
      spec: { title: 'Checkout latency', panels: [], sections: [] },
    },
    {
      uid: 'b-3',
      title: EDGE_TITLE,
      updatedAt: '2026-11-16T08:00:00.000Z',
      spec: {
        title: EDGE_TITLE,
        panels: [
          panel(
            'p-1',
            'Edge p99',
            'promql',
            'histogram_quantile(0.99, sum(rate(edge_request_seconds_bucket{region=~"${region}"}[5m])) by (le))',
            'line',
            [0, 0, 6, 8],
          ),
          panel(
            'p-2',
            'Edge errors',
            'logql',
            'sum by (level) (count_over_time({app="edge"}[1m]))',
            'auto',
            [6, 0, 6, 8],
          ),
          panel(
            'p-3',
            'Pods',
            'promql',
            'sum(kube_pod_status_ready{env="$env"}) by (pod)',
            'heatmap',
            [0, 8, 6, 8],
          ),
        ],
        sections: [],
      },
    },
  ],
};

/** Starred boards seeded when the stub key is absent (organisation-level, as on the BFF). */
export const defaultStarred: readonly string[] = ['b-1'];

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
