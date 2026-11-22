import { ensureSyntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { PromQLExtension, type PrometheusClient } from '@prometheus-io/codemirror-promql';
import { EqlRegex, EqlSingle, Neq, NeqRegex } from '@prometheus-io/lezer-promql';
import { describe, expect, it } from 'vitest';
import { F, fakePromSource } from '../../../test/fakePromSource';
import {
  decodeLabelName,
  matcherContextAt,
  NO_MATCHERS,
  selectorOf,
  toPrometheusClient,
  type MatcherContext,
  type RawMatcher,
} from './promClient';

// B.4.5 of plan #63 Part B.
const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const R = (nt: string, vt: string, t: number = EqlSingle): RawMatcher => ({
  type: t,
  name: BARE.test(nt) ? nt : nt.slice(1, -1),
  value: vt.slice(1, -1),
  nameText: nt,
  valueText: vt,
});
type Matchers = Parameters<PrometheusClient['labelValues']>[2];
const M = (type: number, name: string, value: string) => ({ type, name, value });
const ms = (...xs: ReturnType<typeof M>[]) => xs as unknown as Matchers;

describe('unit:prom-client selectorOf', () => {
  const rows: [string | undefined, RawMatcher[], number, string | null][] = [
    [undefined, [], -1, null],
    ['up', [], -1, 'up'],
    ['', [], -1, null],
    ['up', [R('job', '"api"')], -1, 'up{job="api"}'],
    [
      'up',
      [R('job', '"x"', Neq), R('pod', '"a.*"', EqlRegex), R('ns', '"k"', NeqRegex)],
      -1,
      'up{job!="x",pod=~"a.*",ns!~"k"}',
    ],
    ['up', [R('job', '"api"')], 0, 'up'],
    ['', [R('job', '"api"')], -1, '{job="api"}'],
    ['', [R('job', '"api"')], 0, null],
    ['up', [R('job', '""'), R('instance', '"')], 1, 'up{job=""}'],
    ['up', [R('job', '""', Neq), R('instance', '"')], 1, 'up{job!=""}'],
    ['up', [R('job', '"b"', Neq), R('job', '"')], 1, 'up{job!="b"}'],
    ['up', [R('job', '"a"'), R('job', '"a"')], 1, 'up{job="a"}'],
    ['up', [R('"service.name"', '"api"'), R('job', '"')], 1, 'up{"service.name"="api"}'],
    ['up', [R('a', `'x"y'`), R('job', '"')], 1, `up{a='x"y'}`],
    ['up', [R('a', '`x"y`'), R('job', '"')], 1, 'up{a=`x"y`}'],
    ['up', [R('"a\\"b"', '"x"')], -1, 'up{"a\\"b"="x"}'],
    ['up', [R(`'a"b'`, '"x"')], -1, `up{'a"b'="x"}`],
    ['', [R('__name__', '"my.metric"'), R('job', '"')], 1, '{__name__="my.metric"}'],
    ['', [R('__name__', `'my.metric'`), R('job', '"')], 1, `{__name__='my.metric'}`],
  ];
  for (const [metric, matchers, edited, expected] of rows) {
    it(`${String(metric)} ${JSON.stringify(matchers.map((m) => m.nameText + m.valueText))} ${String(edited)}`, () => {
      expect(selectorOf(metric, matchers, edited)).toBe(expected);
    });
  }
});

describe('unit:prom-client decodeLabelName', () => {
  const rows: [string, string | null][] = [
    ['job', 'job'],
    ['"service.name"', 'service.name'],
    ['"a\\"b"', 'a"b'],
    [`'a"b'`, 'a"b'],
    ["'a\\'b'", "a'b"],
    ['`a\\b`', 'a\\b'],
    ['"\\x41é\\U0001F600"', 'Aé😀'],
    ['"\\303\\251"', 'é'],
    ['"a\\qb"', null],
    ['"a"b"', null],
    ['"ab', null],
    [`'a\\"b'`, null],
    ['"\\xff"', null],
    ['"\\uD800"', null],
    ['x.y', null],
    ['"a\nb"', null],
  ];
  for (const [t, expected] of rows) {
    it(JSON.stringify(t), () => {
      expect(decodeLabelName(t)).toBe(expected);
    });
  }
});

describe('unit:prom-client matcherContextAt', () => {
  const at = (doc: string, pos: number): MatcherContext => {
    const state = EditorState.create({
      doc,
      extensions: new PromQLExtension()
        .activateLinter(false)
        .activateCompletion(false)
        .asExtension(),
    });
    ensureSyntaxTree(state, doc.length, 5000);
    return matcherContextAt(state, pos);
  };
  const rows: [string, number, RawMatcher[], number][] = [
    ['up{job="",instance="', 20, [R('job', '""'), R('instance', '"')], 1],
    ['up{job!="b",job="', 17, [R('job', '"b"', Neq), R('job', '"')], 1],
    ['up{instance="ap", job=""}', 14, [R('instance', '"ap"'), R('job', '""')], 0],
    ['up{job="",instance="ap', 22, [R('job', '""'), R('instance', '"ap')], 1],
    ['up{job="a","service.name"="', 27, [R('"service.name"', '"'), R('job', '"a"')], 0],
    [`up{a='x"y',job="`, 16, [R('a', `'x"y'`), R('job', '"')], 1],
    ['up{a=`x"y`,job="', 16, [R('a', '`x"y`'), R('job', '"')], 1],
    ['up{job="a","a\\"b"="', 19, [R('"a\\"b"', '"'), R('job', '"a"')], 0],
    [`{'my.metric',job="`, 18, [R('__name__', `'my.metric'`), R('job', '"')], 1],
    ['up', 2, [], -1],
    ['sum by (', 8, [], -1],
  ];
  for (const [doc, pos, matchers, edited] of rows) {
    it(`${doc} @${String(pos)}`, () => {
      expect(at(doc, pos)).toEqual({ matchers, edited });
    });
  }
  it('no matchers is NO_MATCHERS', () => {
    expect(at('up', 2)).toEqual(NO_MATCHERS);
  });
});

describe('unit:prom-client toPrometheusClient', () => {
  it('label values under the enclosing selector', async () => {
    const run = async (ctx: MatcherContext, l: string, m: string, list?: Matchers) => {
      const s = fakePromSource(F);
      const got = await toPrometheusClient(s, ctx).labelValues(l, m, list);
      return { got, calls: s.calls };
    };
    expect(
      await run({ matchers: [R('job', '"')], edited: 0 }, 'job', 'up', ms(M(EqlSingle, 'job', ''))),
    ).toEqual({ got: ['api'], calls: ['labelValues job up'] });
    expect(
      await run(
        { matchers: [R('job', '""'), R('instance', '"')], edited: 1 },
        'instance',
        'up',
        ms(M(EqlSingle, 'job', ''), M(EqlSingle, 'instance', '')),
      ),
    ).toEqual({ got: ['api'], calls: ['labelValues instance up{job=""}'] });
    expect(
      await run(
        { matchers: [R('"a\\"b"', '"')], edited: 0 },
        'a\\"b',
        'up',
        ms(M(EqlSingle, 'a\\"b', '')),
      ),
    ).toEqual({ got: ['api'], calls: ['labelValues a"b up'] });
  });

  it('sends nothing when the list, the name or the context differs', async () => {
    const s = fakePromSource(F);
    const c = toPrometheusClient(s, { matchers: [R('job', '"')], edited: 0 });
    expect(await c.labelValues('job', 'up', ms())).toEqual([]);
    expect(await c.labelValues('instance', 'up', ms(M(EqlSingle, 'job', '')))).toEqual([]);
    const q = fakePromSource(F);
    expect(
      await toPrometheusClient(q, { matchers: [R('"a\\qb"', '"')], edited: 0 }).labelValues(
        'a\\qb',
        'up',
        ms(M(EqlSingle, 'a\\qb', '')),
      ),
    ).toEqual([]);
    const n = fakePromSource(F);
    expect(await toPrometheusClient(n, NO_MATCHERS).labelValues('job', 'up')).toEqual([]);
    expect([...s.calls, ...q.calls, ...n.calls]).toEqual([]);
  });

  it('series, names, label names, metadata and flags', async () => {
    const s = fakePromSource(F);
    const c = toPrometheusClient(s, { matchers: [R('job', '"a"')], edited: -1 });
    expect(await c.series('up', ms(M(EqlSingle, 'job', 'a')))).toEqual([new Map([['job', 'a']])]);
    expect(s.calls).toEqual(['series up{job="a"}']);

    const f = fakePromSource(F);
    const n = toPrometheusClient(f, NO_MATCHERS);
    await n.labelNames(undefined);
    await n.labelNames('');
    expect(await n.metricNames('htt')).toEqual(['http_requests_total', 'up']);
    expect(await n.metricMetadata()).toEqual({
      http_requests_total: [{ type: 'counter', help: 'Total HTTP requests.' }],
    });
    expect(await n.flags()).toEqual({});
    expect(f.calls).toEqual(['labelNames null', 'labelNames null', 'metricNames', 'metadata']);

    const names = await n.metricNames();
    names.push('x');
    expect(await n.metricNames()).toEqual(['http_requests_total', 'up']);
    const ls = await n.labelNames();
    ls.push('x');
    expect(await n.labelNames()).toEqual(['instance', 'job']);
  });
});
