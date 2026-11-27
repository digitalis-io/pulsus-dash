/// <reference types="node" />
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BoardSpec, PanelSpec } from '../api/types';
import { messages } from '../i18n/messages.en-GB';
import { fieldMessage, saveFieldMessage } from './fieldMessages';
import { GRID_LIMITS } from './layout';
import { geomapOptions, OPTION_ORDER } from './options';
import { boardListOptions } from '../widgets/boardList/options';
import {
  canonicalJson,
  checkBoardSpec,
  isRfc3339Offset,
  MAX_CONTENT_BYTES,
  MAX_ZONES,
  nextId,
  nextPanelId,
  nextSectionId,
} from './spec';

/** `api/fixtures/board-spec/` (vitest runs in `client/`). */
const FIXTURES = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec');

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
}

interface Case {
  name: string;
  spec?: unknown;
  raw?: string;
  fields: { pointer: string; message_key: string }[];
  /** What the client expects instead of `fields` (zone existence is the server's only). */
  client_fields?: { pointer: string; message_key: string }[];
}

const cases = fixture('invalid.json') as Case[];

type Step = NonNullable<PanelSpec['vis']['thresholds']>['steps'][number];
const STEP: Step = { value: 1, state: 'watch', label: '' };

function v2Full(): BoardSpec {
  return fixture('v2-full.json') as BoardSpec;
}

/** The (mutable) threshold steps of top-level panel `i`. */
function stepsOf(spec: BoardSpec, i: number): Step[] {
  const steps = spec.panels[i]?.vis.thresholds?.steps;
  if (steps === undefined) throw new Error(`panel ${String(i)} has no thresholds`);
  return steps;
}

function panel(id: string, [x, y, w, h]: readonly number[]): PanelSpec {
  return {
    id,
    title: id,
    grid: { x: x ?? 0, y: y ?? 0, w: w ?? 1, h: h ?? 1 },
    query: { lang: 'promql', text: 'up' },
    vis: { kind: 'line' },
  };
}

describe('unit:board-spec-geomap (TS)', () => {
  const geomap = (options: unknown, thresholds?: unknown) => ({
    title: 'B',
    panels: [
      {
        id: 'p-1',
        title: 'A',
        grid: { x: 0, y: 0, w: 6, h: 8 },
        query: { lang: 'promql', text: 'up' },
        vis: { kind: 'geomap', options, ...(thresholds === undefined ? {} : { thresholds }) },
      },
    ],
    sections: [],
  });
  const O = '/panels/0/vis/options';

  it('defaults by geomapOptions', () => {
    const d = {
      location: { mode: 'auto' },
      reducer: 'last',
      size: { by: 'value', min: 4, max: 20 },
      colour: 'group',
      groupBy: null,
      symbol: 'circle',
      labels: 'auto',
      cluster: true,
      wheelZoom: true,
      view: null,
    };
    expect(geomapOptions({})).toEqual(d);
    expect(geomapOptions(undefined)).toEqual(d);
    expect(geomapOptions({ size: { min: 6 }, groupBy: null, view: null })).toEqual({
      ...d,
      size: { by: 'value', min: 6, max: 20 },
    });
    expect(
      geomapOptions({
        location: { mode: 'lookup', field: 'r', gazetteer: 'region', country: 'GB' },
        reducer: 'max',
        size: { by: 'fixed', min: 6, max: 30 },
        colour: 'state',
        groupBy: 'env',
        symbol: 'diamond',
        labels: 'none',
        cluster: false,
        wheelZoom: false,
        view: { lat: 50, lon: 5, zoom: 4 },
      }),
    ).toEqual({
      location: { mode: 'lookup', field: 'r', gazetteer: 'region', country: 'GB' },
      reducer: 'max',
      size: { by: 'fixed', min: 6, max: 30 },
      colour: 'state',
      groupBy: 'env',
      symbol: 'diamond',
      labels: 'none',
      cluster: false,
      wheelZoom: false,
      view: { lat: 50, lon: 5, zoom: 4 },
    });
  });

  it('the v7 fixture is valid; null is a value of groupBy and view only', () => {
    const x = fixture('v7-geomap.json') as BoardSpec;
    expect(checkBoardSpec(x)).toEqual([]);
    expect(x.panels[0]?.vis.kind).toBe('geomap');
    expect(JSON.parse(canonicalJson(x))).toEqual(x);
    expect(checkBoardSpec(geomap({}))).toEqual([]);
    expect(checkBoardSpec(geomap({ groupBy: null, view: null }))).toEqual([]);
    // Null is only a value of groupBy and view.
    expect(checkBoardSpec(geomap({ symbol: null }))).toEqual([
      { pointer: `${O}/symbol`, messageKey: 'board.json.null' },
    ]);
    expect(checkBoardSpec(geomap({ view: { lat: 0, lon: 0, zoom: null } }))).toEqual([
      { pointer: `${O}/view/zoom`, messageKey: 'board.json.null' },
    ]);
  });

  it('geomap rows match the server, and their keys have en-GB text', () => {
    const rows = cases.filter((c) => c.name.startsWith('geomap-'));
    expect(rows.map((c) => c.name)).toEqual([
      'geomap-size-min',
      'geomap-size-order',
      'geomap-colour-state',
      'geomap-groupby',
      'geomap-view-zoom',
      'geomap-view-lon',
      'geomap-depth',
      'geomap-location',
      'geomap-labels',
    ]);
    for (const c of rows) {
      expect(checkBoardSpec(c.spec), c.name).toEqual(
        c.fields.map((f) => ({ pointer: f.pointer, messageKey: f.message_key })),
      );
      for (const f of c.fields) {
        expect(messages, f.message_key).toHaveProperty(`field.${f.message_key}`);
      }
    }
  });

  it('the option rules, as the server', () => {
    const at = (key: string, value: unknown, th?: unknown) =>
      checkBoardSpec(geomap({ [key]: value }, th));
    const bad = (key: string) => [{ pointer: `${O}/${key}`, messageKey: `board.options.${key}.invalid` }];
    const th = { direction: 'above', steps: [{ value: 1, state: 'watch', label: '' }] };
    expect(at('colour', 'state', th)).toEqual([]);
    expect(at('colour', 'state')).toEqual(bad('colour'));
    expect(at('colour', 'pink', th)).toEqual(bad('colour'));
    for (const size of [{ min: 2 }, { min: 40, max: 40 }, { by: 'fixed' }, { max: 4 }, {}])
      expect(at('size', size), JSON.stringify(size)).toEqual([]);
    for (const size of [{ min: 1 }, { min: 5, max: 4 }, { max: 41 }, { min: 30 }, { by: 'area' }])
      expect(at('size', size), JSON.stringify(size)).toEqual(bad('size'));
    for (const view of [
      { lat: 85.0511, lon: -180, zoom: 0 },
      { lat: -85.0511, lon: 179.999, zoom: 14 },
    ])
      expect(at('view', view), JSON.stringify(view)).toEqual([]);
    for (const view of [
      { lat: 85.06, lon: 0, zoom: 1 },
      { lat: 0, lon: 180, zoom: 1 },
      { lat: 0, lon: -180.1, zoom: 1 },
      { lat: 0, lon: 0, zoom: -1 },
      { lat: 0, lon: 0, zoom: 15 },
    ])
      expect(at('view', view), JSON.stringify(view)).toEqual(bad('view'));
    for (const location of [
      { mode: 'auto' },
      { mode: 'coords', lat: 'lat', lon: 'lon' },
      { mode: 'geohash', field: 'gh' },
      { mode: 'lookup', field: 'iata', gazetteer: 'iata' },
      { mode: 'lookup', field: 'r', gazetteer: 'region', country: 'GB' },
    ])
      expect(at('location', location), JSON.stringify(location)).toEqual([]);
    for (const location of [
      { mode: 'auto', field: 'x' },
      { mode: 'coords', lat: 'lat' },
      { mode: 'coords', lat: '1x', lon: 'lon' },
      { mode: 'geohash' },
      { mode: 'lookup', field: 'x' },
      { mode: 'lookup', field: 'x', gazetteer: 'moon' },
      { mode: 'lookup', field: 'x', gazetteer: 'iata', country: 'GB' },
      { mode: 'lookup', field: 'x', gazetteer: 'region', country: 'gb' },
      { mode: 'map' },
    ])
      expect(at('location', location), JSON.stringify(location)).toEqual(bad('location'));
    expect(at('location', { lat: 'x' })).toEqual([
      { pointer: `${O}/location/mode`, messageKey: 'board.json.required' },
    ]);
    expect(at('groupBy', 'env')).toEqual([]);
    expect(at('groupBy', '')).toEqual(bad('groupBy'));
    expect(at('symbol', 'star')).toEqual(bad('symbol'));
    expect(at('labels', 'none')).toEqual([]);
    expect(at('cluster', 'yes')).toEqual([{ pointer: `${O}/cluster`, messageKey: 'board.json.type' }]);
    for (const key of ['tilt', 'projection', 'perspective', 'shadow', '3d', 'depth'])
      expect(at(key, 1), key).toEqual([{ pointer: `${O}/${key}`, messageKey: 'board.json.unknownKey' }]);
  });

  it('the save text: the old server’s unsupported kind on a geomap panel only (§4.5)', () => {
    const spec = geomap({}) as BoardSpec;
    expect(
      saveFieldMessage(spec, { pointer: '/panels/0/vis/kind', messageKey: 'board.vis.kind.invalid' }),
    ).toBe('This server does not support map panels yet');
    expect(
      saveFieldMessage(spec, {
        pointer: '/panels/0/vis/options/size',
        messageKey: 'board.options.size.invalid',
      }),
    ).toBe(fieldMessage('board.options.size.invalid'));
    expect(fieldMessage('board.options.size.invalid')).not.toBe(fieldMessage('board.json.invalid'));
    const line = { ...spec, panels: spec.panels.map((p) => ({ ...p, vis: { kind: 'line' } })) } as BoardSpec;
    expect(
      saveFieldMessage(line, { pointer: '/panels/0/vis/kind', messageKey: 'board.vis.kind.invalid' }),
    ).toBe(fieldMessage('board.vis.kind.invalid'));
  });
});

describe('unit:board-spec (TS)', () => {
  it('v1 fixtures round-trip', () => {
    for (const name of ['v1-minimal.json', 'v1-full.json']) {
      const x = fixture(name);
      expect(checkBoardSpec(x), name).toEqual([]);
      expect(JSON.parse(canonicalJson(x)), name).toEqual(x);
    }
    expect(canonicalJson(fixture('v1-minimal.json'))).toBe(
      '{"panels":[],"sections":[],"title":"New board"}',
    );
  });

  it('invalid fixtures match the server', () => {
    const raw: string[] = [];
    for (const c of cases) {
      if (c.raw !== undefined) {
        raw.push(c.name);
        continue;
      }
      expect(checkBoardSpec(c.spec), c.name).toEqual(
        (c.client_fields ?? c.fields).map((f) => ({
          pointer: f.pointer,
          messageKey: f.message_key,
        })),
      );
    }
    expect(cases.filter((c) => c.client_fields !== undefined).map((c) => c.name)).toEqual([
      'w-zone-unknown',
    ]);
    expect(raw.sort()).toEqual(
      [
        'not-json',
        'trailing-data',
        'empty-body',
        'duplicate-key',
        'float-grid',
        'exp-grid',
        'threshold-value-range',
      ].sort(),
    );
  });

  it('v2 fixture is valid; invalid rows match', () => {
    expect(checkBoardSpec(fixture('v2-full.json'))).toEqual([]);
    const names = new Set(cases.map((c) => c.name));
    for (const n of [
      'threshold-direction',
      'threshold-value-tiny',
      'legend-mode',
      'vis-unknown-key',
    ])
      expect(names.has(n), n).toBe(true);
    // A raw row: `JSON.parse` reads 1e400 as Infinity, which is not a JSON number either.
    const big = cases.find((c) => c.name === 'threshold-value-range');
    expect(checkBoardSpec(JSON.parse(big?.raw ?? 'null'))).toEqual([
      { pointer: '/panels/0/vis/thresholds/steps/0/value', messageKey: 'board.json.type' },
    ]);
  });

  it("v3 fixture is valid, and its canonical form is the server's", () => {
    const x = fixture('v3-full.json');
    expect(checkBoardSpec(x)).toEqual([]);
    const c = canonicalJson(x);
    expect(JSON.parse(c)).toEqual(x);
    // The Go suite (board_test.go v3CanonicalSHA256) holds the same hash: byte-equal forms.
    expect(createHash('sha256').update(c, 'utf8').digest('hex')).toBe(
      '293e4cd4027bf9803c3ce2e467f36d8c41fb0f5b102804b496700df48c22d193',
    );
    const names = new Set(cases.map((k) => k.name));
    for (const n of [
      'options-depth-keys',
      'options-wrong-kind-type',
      'options-before-kind',
      'options-bad-kind-after',
      'options-bad-kind-before',
      'options-kind-not-string',
      'options-types',
      'options-not-object',
      'options-categoryBy',
      'options-max-range',
      'options-min-eq-max',
      'options-enums',
      'options-stat-text-grid',
      'options-in-section',
    ])
      expect(names.has(n), n).toBe(true);
  });

  it("v4 fixture is valid, keeps its tag order, and its canonical form is the server's", () => {
    const x = fixture('v4-board-tags.json');
    expect(checkBoardSpec(x)).toEqual([]);
    const c = canonicalJson(x);
    expect(JSON.parse(c)).toEqual(x);
    expect(c).toContain('"tags":["team:payments","prod"]');
    // The Go suite (board_test.go v4CanonicalSHA256) holds the same hash: byte-equal forms.
    expect(createHash('sha256').update(c, 'utf8').digest('hex')).toBe(
      '1ee8fecd5dbd9f6d70f5b8552f8a5aeb312f9499c5e969ff7d2a231d753e3a3f',
    );
    expect(checkBoardSpec({ title: 'T', panels: [], sections: [], tags: [] })).toEqual([]);
  });

  it("v5 fixture is valid, and its canonical form is the server's", () => {
    const x = fixture('v5-widgets.json') as BoardSpec;
    expect(checkBoardSpec(x)).toEqual([]);
    const c = canonicalJson(x);
    expect(JSON.parse(c)).toEqual(x);
    // The Go suite (board_test.go v5CanonicalSHA256) holds the same hash: byte-equal forms.
    expect(createHash('sha256').update(c, 'utf8').digest('hex')).toBe(
      'a42813fc4b36e478ec6dac2a4b5707bd1c50377def15a749ea2d34a8b6bd134f',
    );
    const withQuery = [...x.panels, ...x.sections.flatMap((s) => s.panels)]
      .filter((p) => 'query' in p)
      .map((p) => p.id);
    expect(withQuery).toEqual(['p-5']);
  });

  it("v6 fixture is valid, and its canonical form is the server's", () => {
    const x = fixture('v6-board-list.json') as BoardSpec;
    expect(checkBoardSpec(x)).toEqual([]);
    const c = canonicalJson(x);
    expect(JSON.parse(c)).toEqual(x);
    // The Go suite (board_test.go v6CanonicalSHA256) holds the same hash: byte-equal forms.
    expect(createHash('sha256').update(c, 'utf8').digest('hex')).toBe(
      'f34068a04a37a48064fc82720a092473249c985e3cfd9e0f30f8103fbb7b5e87',
    );
    const withQuery = [...x.panels, ...x.sections.flatMap((s) => s.panels)]
      .filter((p) => 'query' in p)
      .map((p) => p.id);
    expect(withQuery).toEqual(['p-5']);
  });

  it('board-list rows match the server, and their keys have en-GB text', () => {
    const rows = cases.filter((c) => c.name.startsWith('bl-'));
    expect(rows).toHaveLength(14);
    for (const c of rows) {
      expect(checkBoardSpec(c.spec), c.name).toEqual(
        c.fields.map((f) => ({ pointer: f.pointer, messageKey: f.message_key })),
      );
      for (const f of c.fields) {
        expect(messages, f.message_key).toHaveProperty(`field.${f.message_key}`);
      }
    }
    expect(
      [
        'board.options.mode.invalid',
        'board.options.sort.invalid',
        'board.options.query.invalid',
        'board.options.tag.invalid',
        'board.options.limit.invalid',
      ].map(fieldMessage),
    ).toEqual([
      'Choose a listed mode.',
      'Choose a listed sort order.',
      'Use up to 100 characters without control characters, in search mode only.',
      'Use one valid tag, in tag mode only.',
      'Use a whole number from 1 to 50.',
    ]);
  });

  it('board-list bounds, as the server', () => {
    const O = '/panels/0/vis/options';
    const list = (options: unknown) => ({
      title: 'B',
      panels: [
        {
          id: 'p-1',
          title: 'A',
          grid: { x: 0, y: 0, w: 6, h: 8 },
          vis: { kind: 'boardList', options },
        },
      ],
      sections: [],
    });
    const search = (query: string) => list({ mode: 'search', query });
    expect(checkBoardSpec(search('é'.repeat(100)))).toEqual([]);
    for (const limit of [1, 50, 1e1])
      expect(checkBoardSpec(list({ limit })), String(limit)).toEqual([]);
    expect(checkBoardSpec(search('a\u0085b'))).toEqual([
      { pointer: `${O}/query`, messageKey: 'board.options.query.invalid' },
    ]);
    expect(checkBoardSpec(search('a\u0000'))).toEqual([
      { pointer: `${O}/query`, messageKey: 'board.string.nul' },
    ]);
  });

  it('board-list options with the defaults', () => {
    expect(boardListOptions({})).toEqual({
      mode: 'starred',
      query: '',
      tag: null,
      limit: 10,
      sort: 'default',
    });
    expect(boardListOptions()).toEqual(boardListOptions({}));
    expect(boardListOptions({ mode: 'tag', tag: 'a', limit: 5 })).toEqual({
      mode: 'tag',
      query: '',
      tag: 'a',
      limit: 5,
      sort: 'default',
    });
  });

  it('widget rows match the server, and their keys have en-GB text', () => {
    const byName = new Map(cases.map((c) => [c.name, c]));
    const rows = cases.filter((c) => c.name.startsWith('w-'));
    expect(rows).toHaveLength(23);
    for (const c of rows) {
      expect(byName.get(c.name), c.name).toBe(c);
      for (const f of c.fields) {
        expect(messages, f.message_key).toHaveProperty(`field.${f.message_key}`);
      }
    }
    for (const key of [
      'board.panel.query.forbidden',
      'board.panel.query.required',
      'board.options.mode.invalid',
      'board.options.content.tooLong',
      'board.options.language.invalid',
      'board.options.zones.invalid',
      'board.options.zones.duplicate',
      'board.options.hourCycle.invalid',
      'board.options.countdown.invalid',
    ]) {
      expect(messages, key).toHaveProperty(`field.${key}`);
      expect(fieldMessage(key), key).not.toBe(fieldMessage('board.no.such.key'));
    }
    expect(messages).toHaveProperty('widget.kindUnavailable');
  });

  it('widget limits', () => {
    const O = '/panels/0/vis/options';
    const widget = (vis: unknown) => ({
      title: 'B',
      panels: [{ id: 'p-1', title: 'A', grid: { x: 0, y: 0, w: 6, h: 8 }, vis }],
      sections: [],
    });
    const text = (content: string) => widget({ kind: 'text', options: { content } });
    const zone = (tz: string, label = '') => ({ tz, label });
    const zones = (n: number) =>
      widget({
        kind: 'clock',
        options: {
          zones: Array.from({ length: n }, (_, i) =>
            zone(i === 0 ? 'UTC' : `Etc/GMT+${String(i)}`),
          ),
        },
      });
    const countdown = (label: string) =>
      widget({
        kind: 'clock',
        options: { countdown: { to: '2026-11-26T14:00:00Z', label, after: 'hide' } },
      });
    const at = (pointer: string, key: string) => [{ pointer: `${O}${pointer}`, messageKey: key }];
    const content = `${'€'.repeat(21845)}a`;
    expect(new TextEncoder().encode(content).length).toBe(MAX_CONTENT_BYTES);
    expect(checkBoardSpec(text(content))).toEqual([]);
    expect(checkBoardSpec(text(`${content}a`))).toEqual(
      at('/content', 'board.options.content.tooLong'),
    );
    expect(MAX_ZONES).toBe(12);
    expect(checkBoardSpec(zones(12))).toEqual([]);
    expect(checkBoardSpec(zones(13))).toEqual(at('/zones', 'board.options.zones.invalid'));
    const labelled = (label: string) =>
      widget({ kind: 'clock', options: { zones: [zone('UTC', label)] } });
    expect(checkBoardSpec(labelled('é'.repeat(64)))).toEqual([]);
    expect(checkBoardSpec(labelled('é'.repeat(65)))).toEqual(
      at('/zones/0/label', 'board.options.zones.invalid'),
    );
    expect(checkBoardSpec(countdown(''))).toEqual(
      at('/countdown/label', 'board.options.countdown.invalid'),
    );
    expect(checkBoardSpec(countdown('é'.repeat(64)))).toEqual([]);
  });

  it("isRfc3339Offset is the server's", () => {
    for (const s of [
      '2026-11-26T14:00:00Z',
      '2026-11-26T14:00:00+09:00',
      '2026-11-26T14:00:00.123456789-05:30',
      '2024-02-29T00:00:00Z',
    ])
      expect(isRfc3339Offset(s), s).toBe(true);
    for (const s of [
      '2026-11-26 14:00',
      '2026-11-26T14:00:00',
      '2026-02-29T00:00:00Z',
      '2026-11-26T24:00:00Z',
      '2026-11-26T14:00:60Z',
      '2026-11-26T14:00:00+24:00',
      '2026-11-26T14:00:00z',
    ])
      expect(isRfc3339Offset(s), s).toBe(false);
  });

  it('tag rows match the server, and their keys have en-GB text', () => {
    const tagRows = [
      'tags-too-many',
      'tags-uppercase',
      'tags-duplicate',
      'tags-null',
      'tags-not-array',
      'tags-item-number',
      'tags-empty',
      'tags-too-long',
      'tags-nul',
    ];
    const byName = new Map(cases.map((c) => [c.name, c]));
    for (const n of tagRows) {
      const c = byName.get(n);
      expect(c, n).toBeDefined();
      expect(checkBoardSpec(c?.spec), n).toEqual(
        (c?.fields ?? []).map((f) => ({ pointer: f.pointer, messageKey: f.message_key })),
      );
    }
    for (const key of ['board.tags.invalid', 'board.tags.duplicate']) {
      expect(messages, key).toHaveProperty(`field.${key}`);
      expect(fieldMessage(key), key).not.toBe(fieldMessage('board.no.such.key'));
    }
  });

  it('a NaN or out-of-range option bound', () => {
    const spec = fixture('v3-full.json') as BoardSpec;
    const opts = spec.panels[0]?.vis.options;
    if (opts === undefined) throw new Error('p-1 has no options');
    opts.min = NaN;
    expect(checkBoardSpec(spec)).toEqual([
      { pointer: '/panels/0/vis/options/min', messageKey: 'board.json.type' },
    ]);
    opts.min = -1e15;
    expect(checkBoardSpec(spec)).toEqual([]);
    opts.min = -1.0000001e15;
    expect(checkBoardSpec(spec)).toEqual([
      { pointer: '/panels/0/vis/options/min', messageKey: 'board.options.min.invalid' },
    ]);
  });

  it('every option key has text', () => {
    const catalogue = new Set<string>(Object.values(messages));
    expect(OPTION_ORDER).toHaveLength(34);
    // The widget keys (T24 §5.1): content has a byte bound, seconds and date no rule; the geomap's
    // cluster and wheelZoom (T24 §5.15) none either.
    const keyOf: Partial<Record<string, string | null>> = {
      content: 'content.tooLong',
      seconds: null,
      date: null,
      cluster: null,
      wheelZoom: null,
    };
    for (const k of OPTION_ORDER) {
      const rule = keyOf[k] === undefined ? `${k}.invalid` : keyOf[k];
      if (rule === null) continue;
      const key = `board.options.${rule}`;
      const text = fieldMessage(key);
      expect(text, key).not.toBe(fieldMessage('board.json.invalid'));
      expect(catalogue.has(text), key).toBe(true);
    }
  });

  it('v2-threshold-bounds fixture is valid', () => {
    const x = fixture('v2-threshold-bounds.json');
    expect(checkBoardSpec(x)).toEqual([]);
    expect(canonicalJson(x)).toBe(canonicalJson(JSON.parse(canonicalJson(x))));
  });

  it('a NaN threshold value is board.json.type', () => {
    const spec = v2Full();
    stepsOf(spec, 0)[0] = { ...(stepsOf(spec, 0)[0] ?? STEP), value: NaN };
    expect(checkBoardSpec(spec)).toEqual([
      { pointer: '/panels/0/vis/thresholds/steps/0/value', messageKey: 'board.json.type' },
    ]);
  });

  it('threshold values outside the range', () => {
    const out = [Number.MAX_VALUE, -Number.MAX_VALUE, 1.0000001e15, 5e-324, -5e-324, 1e-10, -1e-10];
    const kept = [1e15, 1e-9, -1e-9, 0];
    // v2-full's p-1 holds a 1e15 step: each case replaces it (steps[2]).
    expect(stepsOf(v2Full(), 0)[2]?.value).toBe(1e15);
    const at = (value: number) => {
      const spec = v2Full();
      const steps = stepsOf(spec, 0);
      steps[2] = { ...(steps[2] ?? STEP), value };
      return checkBoardSpec(spec);
    };
    for (const v of out) {
      expect(at(v), String(v)).toEqual([
        {
          pointer: '/panels/0/vis/thresholds/steps/2/value',
          messageKey: 'board.thresholds.value.range',
        },
      ]);
    }
    for (const v of kept) expect(at(v), String(v)).toEqual([]);
  });

  it('every message key has text', () => {
    const keys = new Set(cases.flatMap((c) => c.fields.map((f) => f.message_key)));
    expect(keys.size).toBeGreaterThan(20);
    const catalogue = new Set<string>(Object.values(messages));
    for (const key of keys) {
      const text = fieldMessage(key);
      expect(text, key).not.toBe('');
      expect(catalogue.has(text), key).toBe(true);
    }
  });

  it('nextPanelId', () => {
    const spec = (ids: string[]): BoardSpec => ({
      title: 'B',
      panels: ids.map((id) => panel(id, [0, 0, 1, 1])),
      sections: [],
    });
    expect(nextPanelId(spec([]))).toBe('p-1');
    expect(nextPanelId(spec(['p-1', 'x', 'p-9']))).toBe('p-10');
  });

  it('nextPanelId avoids section ids and large suffixes', () => {
    const withSection: BoardSpec = {
      title: 'B',
      panels: [],
      sections: [{ id: 'p-1', title: 'S', collapsed: false, panels: [] }],
    };
    expect(checkBoardSpec(withSection)).toEqual([]);
    const id = nextPanelId(withSection);
    expect(id).not.toBe('p-1');
    expect(checkBoardSpec({ ...withSection, panels: [panel(id, [0, 0, 1, 1])] })).toEqual([]);

    const big = (ids: string[]): BoardSpec => ({
      title: 'B',
      panels: ids.map((x, i) => panel(x, [0, i, 1, 1])),
      sections: [],
    });
    // Past 2^53 a Number + 1 rounds back onto an id in use.
    expect(nextPanelId(big(['p-9007199254740993']))).toBe('p-9007199254740994');
    // One more than 38 nines does not fit the 40-character id: the lowest free id is used.
    const nines = `p-${'9'.repeat(38)}`;
    expect(checkBoardSpec(big([nines]))).toEqual([]);
    expect(nextPanelId(big([nines]))).toBe('p-1');
    expect(nextPanelId(big([nines, 'p-1', 'p-2']))).toBe('p-3');
  });

  it('limits match the server', () => {
    expect(GRID_LIMITS).toEqual({ cols: 12, maxY: 9999, maxH: 100, maxBottom: 10099 });
    const out = cases.find((c) => c.name === 'grid-out-of-bounds');
    expect(out?.fields).toEqual([
      { pointer: '/panels/0/grid', message_key: 'board.grid.outOfBounds' },
    ]);
    const board = (grid: readonly number[]): BoardSpec => ({
      title: 'B',
      panels: [panel('p-1', grid)],
      sections: [],
    });
    const bounds = [{ pointer: '/panels/0/grid', messageKey: 'board.grid.outOfBounds' }];
    expect(checkBoardSpec(board([0, 9999, 12, 100]))).toEqual([]);
    expect(checkBoardSpec(board([0, 10000, 12, 1]))).toEqual(bounds);
    expect(checkBoardSpec(board([0, 0, 12, 101]))).toEqual(bounds);
  });
});

describe('section ids', () => {
  it('nextSectionId', () => {
    const empty: BoardSpec = { title: 'B', panels: [], sections: [] };
    expect(nextSectionId(empty)).toBe('s-1');
    const sec = (id: string) => ({ id, title: '', collapsed: false, panels: [] });
    const spec: BoardSpec = {
      title: 'B',
      panels: [panel('s-9', [0, 0, 1, 1])],
      sections: [sec('s-1'), sec('s-7')],
    };
    expect(nextSectionId(spec)).toBe('s-10');
    expect(nextId(spec, 'p')).toBe(nextPanelId(spec));
  });
});
