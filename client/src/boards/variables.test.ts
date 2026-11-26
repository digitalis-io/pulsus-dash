import { describe, expect, it } from 'vitest';
import type { BoardSpec, PanelSpec } from '../api/types';
import { boardVariables } from './variables';

function p(id: string, text: string, lang: 'promql' | 'logql' = 'promql'): PanelSpec {
  return {
    id,
    title: id,
    grid: { x: 0, y: 0, w: 1, h: 1 },
    query: { lang, text },
    vis: { kind: 'auto' },
  };
}

describe('board variables', () => {
  it('board variables', () => {
    const name64 = `a${'b'.repeat(63)}`;
    const name65 = `a${'c'.repeat(64)}`;
    const spec: BoardSpec = {
      title: 'B',
      panels: [
        p('p-1', 'rate(x{region=~"$region"}[5m])'),
        p('p-2', 'y{env="${env}", r="$region"}'),
      ],
      sections: [
        {
          id: 's-1',
          title: 'S',
          collapsed: false,
          panels: [
            p('p-3', 'z{pod="$pod"}[$__rate_interval]'),
            p('p-4', '{a="b"} |~ "x$" | label_format c="$1"', 'logql'),
            p('p-5', `up{a="$${name65}"}`),
            p('p-6', `up{a="$${name64}"}`),
          ],
        },
      ],
    };
    expect(boardVariables(spec)).toEqual(['region', 'env', 'pod', name64]);
    expect(boardVariables({ title: 'E', panels: [], sections: [] })).toEqual([]);
  });

  it('a Markdown text adds its references after the data panels (unit:board-variables, plan #198 Part 3a §4.1)', () => {
    const spec: BoardSpec = {
      title: 'B',
      panels: [
        p('p-1', 'rate(x{env="$env"}[5m])', 'promql'),
        {
          id: 'p-2',
          title: 'Notes',
          grid: { x: 0, y: 1, w: 1, h: 1 },
          vis: { kind: 'text', options: { mode: 'markdown', content: '$region ${env}' } },
        },
        {
          id: 'p-3',
          title: 'Code',
          grid: { x: 1, y: 1, w: 1, h: 1 },
          vis: { kind: 'text', options: { mode: 'code', language: 'shell', content: 'echo $x' } },
        },
        {
          id: 'p-4',
          title: 'Clock',
          grid: { x: 2, y: 1, w: 1, h: 1 },
          vis: { kind: 'clock', options: {} },
        },
      ],
      sections: [],
    };
    expect(boardVariables(spec)).toEqual(['env', 'region']);
  });

  it('a text in the default mode is Markdown; data panels come first', () => {
    const spec: BoardSpec = {
      title: 'B',
      panels: [
        {
          id: 'p-2',
          title: 'Notes',
          grid: { x: 0, y: 1, w: 1, h: 1 },
          vis: { kind: 'text', options: { content: '$region' } },
        },
      ],
      sections: [
        {
          id: 's-1',
          title: 'S',
          collapsed: false,
          panels: [p('p-1', 'rate(x{env="$env"}[5m])', 'promql')],
        },
      ],
    };
    expect(boardVariables(spec)).toEqual(['env', 'region']);
  });
});
