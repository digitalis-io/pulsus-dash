/**
 * The widget gallery's pages (plan #198 Part 3b §2; VIZ-069): the corpus of `golden:widget-gallery`.
 * Each page is a list of Text panels; `widget-text-removals` shows its one panel in the editor body,
 * so the "Not shown in the panel" list is in the shot. `RUNBOOK` (2 KiB) is also the four small
 * panels of `bench:text-widget-render`.
 *
 * This module has no imports beyond types: the e2e bench loads it in Node.
 */
import type { WidgetPanelSpec } from '../api/types';

export const WIDGET_GALLERY_PAGES = ['widget-text', 'widget-text-removals'] as const;
export type WidgetGalleryPage = (typeof WIDGET_GALLERY_PAGES)[number];

export function widgetGalleryPage(raw: string | null): WidgetGalleryPage {
  return (WIDGET_GALLERY_PAGES as readonly string[]).includes(raw ?? '')
    ? (raw as WidgetGalleryPage)
    : 'widget-text';
}

/** The values of the gallery's board variables. */
export const WIDGET_GALLERY_VARS: ReadonlyMap<string, string> = new Map([['env', 'prod']]);

/** A 2 KiB runbook: headings, lists, a quote, code and links (local and `mailto:`). */
export const RUNBOOK = [
  '# Checkout runbook ($env)',
  '',
  'Use this page when the **checkout** service pages on-call. Start with the board, then the logs.',
  '',
  '## First five minutes',
  '',
  '1. Open [Service overview](/t/demo/board/b-1) and check the request rate and the error ratio.',
  '2. Compare with the same window yesterday; a deploy shows as a step, not a slope.',
  '3. If the error ratio is above *2 %*, page the payments team.',
  '',
  '## Useful queries',
  '',
  '- Rate: `sum by (job) (rate(http_requests_total[5m]))`',
  '- Errors: `sum(rate(http_requests_total{code=~"5.."}[5m]))`',
  '- Latency: `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))`',
  '- Saturation: `max by (instance) (process_open_fds / process_max_fds)`',
  '',
  '> The p95 is the number the customers feel. A healthy p95 with a bad p99 means a slow',
  '> dependency for a few requests, not an overloaded service.',
  '',
  '## Mitigations',
  '',
  '- Roll back the last deploy from the release tool.',
  '- Shed the recommendations call: it is optional on the checkout path.',
  '- Scale the API tier by two replicas; the database is rarely the limit.',
  '- Turn off the promotions banner, which calls the pricing service on every page.',
  '',
  '```promql',
  'sum by (instance) (rate(process_cpu_seconds_total{job="checkout"}[5m]))',
  '```',
  '',
  '## After the incident',
  '',
  '1. Confirm the error ratio has been below *0.5 %* for thirty minutes before you stand down.',
  '2. Note the start, the detection, the mitigation and the end times in the incident record.',
  '3. Link the deploy, the config change or the dependency that caused it, with the evidence.',
  '4. Open follow-up issues for every alert that fired late, fired twice or did not fire at all.',
  '',
  '## Known noisy signals',
  '',
  '- The **cart-sync** job retries for five minutes after a cache flush; its errors are expected.',
  '- Latency doubles during the nightly report export between 02:00 and 02:20 UTC.',
  '- A single pod restart shows as a short gap in the rate panel, not as an outage.',
  '',
  '---',
  '',
  'Mail the [payments on-call](mailto:payments-oncall@example.test) before escalating an outage, and',
  'read the [escalation policy](/t/demo/boards) for who to call. Write up every page within two days.',
  '',
].join('\n');

/** A code panel's content (PromQL). */
const QUERY = [
  'sum by (job) (',
  '  rate(http_requests_total{env="prod"}[5m])',
  ')',
  '/ ignoring (code) group_left',
  'sum by (job) (rate(http_requests_total[5m]))',
].join('\n');

/**
 * The editor body's content: an HTML block, inline HTML, an iframe, a `javascript:` link, an
 * image under `/api` (counted as external, T24-018), an unset variable and a 31-deep quote, one
 * removal each. No absolute URL: the build's origin check allows none in app code.
 */
export const REMOVALS = [
  '# Release notes',
  '',
  '<div class="banner">Maintenance tonight</div>',
  '',
  'Deploys are <b>frozen</b> until Friday.',
  '',
  '<iframe src="/status/embed"></iframe>',
  '',
  'Open the [console](javascript:alert(1)) for details.',
  '',
  '![Status](/api/status/badge.png)',
  '',
  'Owner: $missing',
  '',
  `${'> '.repeat(31)}Deeply quoted note.`,
  '',
].join('\n');

const text = (
  id: string,
  title: string,
  options: { mode: 'markdown' | 'code'; content: string; language?: 'promql' },
): WidgetPanelSpec => ({
  id,
  title,
  grid: { x: 0, y: 0, w: 6, h: 8 },
  vis: { kind: 'text', options },
});

/** The panels of a page, in order. */
export function widgetGalleryPanels(page: WidgetGalleryPage): readonly WidgetPanelSpec[] {
  if (page === 'widget-text-removals') {
    return [text('text-removals', 'Release notes', { mode: 'markdown', content: REMOVALS })];
  }
  return [
    text('text-runbook', 'Checkout runbook', { mode: 'markdown', content: RUNBOOK }),
    text('text-code', 'Error ratio query', { mode: 'code', language: 'promql', content: QUERY }),
    text('text-empty', 'Notes', { mode: 'markdown', content: '' }),
  ];
}
