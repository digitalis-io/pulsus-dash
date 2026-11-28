/** `unit:legend-format` (#204): legend name templates, their display names and the hover rows. */
import { describe, expect, it } from 'vitest';
import type { FrameData } from '../data/frames';
import type { HoverEvent } from '../engine/api';
import { EMPTY_COMPLETENESS, fixture, fkey } from '../test/histogramFixtures';
import {
  displayName,
  isLegendFormat,
  MAX_LEGEND_FORMAT,
  namedHover,
  renderLegendFormat,
  resultLabelNames,
  seriesNames,
} from './legendFormat';

const L = { __name__: 'up', instance: 'n1:9000', job: 'clickhouse' };

describe('unit:legend-format', () => {
  it('replaces each {{label}} with its value', () => {
    expect(renderLegendFormat('{{instance}} select', L)).toBe('n1:9000 select');
    expect(renderLegendFormat('{{job}}/{{instance}}', L)).toBe('clickhouse/n1:9000');
    expect(renderLegendFormat('{{__name__}}', L)).toBe('up');
    expect(renderLegendFormat('no placeholders', L)).toBe('no placeholders');
  });

  it('allows spaces inside the braces', () => {
    expect(renderLegendFormat('{{ instance }} · {{  job}}', L)).toBe('n1:9000 · clickhouse');
  });

  it('a missing label renders empty', () => {
    expect(renderLegendFormat('{{pod}} select', L)).toBe(' select');
    expect(renderLegendFormat('{{pod}}', {})).toBe('');
  });

  it('a repeated label is replaced each time', () => {
    expect(renderLegendFormat('{{instance}}={{instance}}', L)).toBe('n1:9000=n1:9000');
  });

  it('braces that are no placeholder stay literal', () => {
    expect(renderLegendFormat('{instance}', L)).toBe('{instance}');
    expect(renderLegendFormat('{{}} {{ 1x }} }}{{', L)).toBe('{{}} {{ 1x }} }}{{');
    expect(renderLegendFormat('{{{instance}}}', L)).toBe('{n1:9000}');
    expect(renderLegendFormat('{{instance', L)).toBe('{{instance');
  });

  it('a value is inserted as it is, never read as a template', () => {
    expect(renderLegendFormat('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
    expect(renderLegendFormat('{{a}}', { a: '$& $1' })).toBe('$& $1');
  });

  it('without a template the name is the full label set', () => {
    expect(displayName(L, null)).toBe('up{instance="n1:9000", job="clickhouse"}');
    expect(displayName(L, '{{instance}}')).toBe('n1:9000');
  });

  it('1 to 256 code points, the server rule', () => {
    expect(MAX_LEGEND_FORMAT).toBe(256);
    expect(isLegendFormat('a'.repeat(256))).toBe(true);
    expect(isLegendFormat('a'.repeat(257))).toBe(false);
    expect(isLegendFormat('\u{1D465}'.repeat(256))).toBe(true);
    expect(isLegendFormat('\u{1D465}'.repeat(257))).toBe(false);
    expect(isLegendFormat('')).toBe(false);
    expect(isLegendFormat('{{instance}}')).toBe(true);
  });

  it('identical rendered names keep their own series keys', () => {
    const data: FrameData = {
      kind: 'series',
      series: fixture([
        { labels: { instance: 'n1', job: 'a' }, values: [1, 2] },
        { labels: { instance: 'n1', job: 'b' }, values: [3, 4] },
      ]),
    };
    const names = seriesNames(data, '{{instance}}');
    expect(names).not.toBeNull();
    expect([...(names ?? new Map<string, string>())]).toEqual([
      [fkey(0), 'n1'],
      [fkey(1), 'n1'],
    ]);
    expect(seriesNames(data, null)).toBeNull();
    expect(seriesNames({ kind: 'scalar', scalar: { value: 1, timestampMs: 0 } }, '{{a}}')).toBe(
      null,
    );
  });

  it('renames the hover rows by key, and leaves the rest of the event', () => {
    const h: HoverEvent = {
      source: 'pointer',
      tMs: 5000,
      xCss: 10,
      yCss: 20,
      rows: [
        { key: fkey(0), name: '{instance="n1", job="a"}', colourIndex: 0, value: 2 },
        { key: fkey(1), name: '{instance="n1", job="b"}', colourIndex: 1, value: 4 },
        { key: 'other', name: 'kept', colourIndex: null, value: 0 },
      ],
    };
    const names = new Map([
      [fkey(0), 'n1'],
      [fkey(1), 'n1'],
    ]);
    const out = namedHover(h, names);
    expect(out?.rows.map((r) => [r.key, r.name])).toEqual([
      [fkey(0), 'n1'],
      [fkey(1), 'n1'],
      ['other', 'kept'],
    ]);
    expect(out?.tMs).toBe(5000);
    expect(namedHover(h, null)).toBe(h);
    expect(namedHover(null, names)).toBeNull();
  });

  it('the label names of a result, sorted and once each', () => {
    expect(
      resultLabelNames({
        kind: 'series',
        source: 'range',
        stepMs: 5000,
        completeness: EMPTY_COMPLETENESS,
        series: fixture([
          { labels: { job: 'a', instance: 'n1', __name__: 'up' }, values: [1, 1] },
          { labels: { instance: 'n2', pod: 'p' }, values: [1, 1] },
        ]),
      }),
    ).toEqual(['__name__', 'instance', 'job', 'pod']);
    expect(
      resultLabelNames({
        kind: 'scalar',
        scalar: { value: 1, timestampMs: 0 },
        completeness: EMPTY_COMPLETENESS,
      }),
    ).toEqual([]);
  });
});
