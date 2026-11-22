import { describe, expect, it } from 'vitest';
import { STUB_PROM_METADATA, STUB_PROM_METRIC_NAMES } from '../api/stubData';
import { metricOptions, PICKER_OPTIONS } from './metricOptions';

describe('metricOptions', () => {
  it('all names for an empty filter, with descriptions', () => {
    const r = metricOptions(STUB_PROM_METRIC_NAMES, STUB_PROM_METADATA, '  ');
    expect(r.total).toBe(5);
    expect(r.options.map((o) => o.name)).toEqual([...STUB_PROM_METRIC_NAMES].sort());
    expect(r.options.find((o) => o.name === 'stub_metric')?.description).toBe('');
    expect(r.options.find((o) => o.name === 'http_requests_total')?.description).toBe(
      'counter · Total HTTP requests.',
    );
  });

  it('memory', () => {
    expect(metricOptions(STUB_PROM_METRIC_NAMES, STUB_PROM_METADATA, 'memory')).toEqual({
      options: [{ name: 'node_memory_free_bytes', description: 'gauge · Free memory in bytes.' }],
      total: 1,
    });
  });

  it('HTTP: case-insensitive, prefix matches first', () => {
    const names = ['a_http_x', 'http_requests_total', 'b_http', 'http_a'];
    expect(metricOptions(names, {}, 'HTTP').options.map((o) => o.name)).toEqual([
      'http_a',
      'http_requests_total',
      'a_http_x',
      'b_http',
    ]);
  });

  it('a _bucket name takes its base help and type', () => {
    expect(metricOptions(STUB_PROM_METRIC_NAMES, STUB_PROM_METADATA, '_bucket').options).toEqual([
      {
        name: 'http_request_duration_seconds_bucket',
        description: 'histogram · HTTP request duration.',
      },
    ]);
  });

  it('only a type, or only help', () => {
    const meta = {
      a: [{ type: 'gauge', help: '', unit: '' }],
      b: [{ type: 'unknown', help: 'Bee.', unit: '' }],
    };
    expect(metricOptions(['a', 'b'], meta, '').options.map((o) => o.description)).toEqual([
      'gauge',
      'Bee.',
    ]);
  });

  it('250 names → 100 options, total 250', () => {
    const names = Array.from({ length: 250 }, (_, i) => `m_${String(i).padStart(3, '0')}`);
    const r = metricOptions(names, {}, '');
    expect(r.options).toHaveLength(PICKER_OPTIONS);
    expect(r.total).toBe(250);
  });
});
