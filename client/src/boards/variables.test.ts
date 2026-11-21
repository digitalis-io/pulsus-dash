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
});
