import { describe, expect, it } from 'vitest';
import type { DataPanelSpec, DataVisKind } from '../api/types';
import type { ContextSearch } from '../state/contextSearch';
import { exploreHref } from './exploreLink';

const ABS: ContextSearch = {
  from: '2026-11-19T12:00:00.000Z',
  to: '2026-11-19T13:00:00.000Z',
  refresh: 'off',
};
const Q = 'from=2026-11-19T12%3A00%3A00.000Z&to=2026-11-19T13%3A00%3A00.000Z&refresh=off';

function p(
  text: string,
  kind: DataVisKind = 'auto',
  lang: 'promql' | 'logql' = 'promql',
): DataPanelSpec {
  return {
    id: 'p-1',
    title: 'A',
    grid: { x: 0, y: 0, w: 6, h: 8 },
    query: { lang, text },
    vis: { kind },
  };
}

describe('exploreHref', () => {
  it.each([
    ['L1', p('up'), 'up', `/t/demo/explore/metrics?${Q}&q=up`],
    ['L2', p('up', 'bars'), 'up', `/t/demo/explore/metrics?${Q}&q=up&vis=bars`],
    ['L3', p('up', 'logs'), 'up', `/t/demo/explore/metrics?${Q}&q=up`],
    ['L4', p('up{r="$r"}'), null, null],
    // unit:explore-link (plan #67): a LogQL panel links the server's expanded text, else nothing.
    [
      'L5',
      p('{app="$app"}', 'auto', 'logql'),
      '{app="a"}',
      `/t/demo/explore/logs?${Q}&q=%7Bapp%3D%22a%22%7D`,
    ],
    ['L5b', p('{app="$app"}', 'bars', 'logql'), null, null],
    ['L6', p('x[$__interval]'), 'x[30s]', `/t/demo/explore/metrics?${Q}&q=x%5B30s%5D`],
    [
      'L7',
      p('http_requests_total'),
      'http_requests_total',
      `/t/demo/explore/metrics?${Q}&q=http_requests_total`,
    ],
    // #173 Part 3b: a bar chart opens Explore's bar chart; a pie opens on Auto.
    ['L8', p('up', 'barchart'), 'up', `/t/demo/explore/metrics?${Q}&q=up&vis=barchart`],
    ['L9', p('up', 'pie'), 'up', `/t/demo/explore/metrics?${Q}&q=up`],
  ] as const)('%s', (_n, panel, expanded, href) => {
    expect(exploreHref('demo', panel, ABS, expanded)).toBe(href);
  });
});
