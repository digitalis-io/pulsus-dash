/**
 * unit:plan-parity (TS, logs) and unit:logql-classify (TS) (plan #116 §5.2): the StubApi LogQL
 * planner mirror runs every case of the shared fixture as the Go planner does, by its outcome
 * (plan #116 §3.5), and the fixture's tables.
 */
import { describe, expect, it } from 'vitest';
import {
  expand,
  LOGS_FIXTURE,
  logsFieldsOf,
  logsPlannedOf,
  type LogsFacts,
  type LogsPlanCase,
} from './logsPlanFixture';
import {
  classifyLogs,
  isLogsPlanError,
  logsFormatDuration,
  logsRateWindowMs,
  prepareLogs,
  volumeRange,
  type LogsClass,
  type LogsStubPlanError,
} from './logsPlan';
import { reservedIn } from './plan';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The UTF-8 bytes [from, to) of text. */
const slice = (text: string, from: number, to: number): string =>
  decoder.decode(encoder.encode(text).subarray(from, to));

const facts = (c: LogsClass): LogsFacts => ({ class: c.source, reserved: [...c.reserved] });

function inputsOf(c: LogsPlanCase) {
  return {
    query: expand(c.inputs.query),
    vars: c.inputs.vars,
    kind: c.inputs.kind,
    stepMs: c.inputs.step_ms,
  };
}

function wantError(c: LogsPlanCase): LogsStubPlanError {
  if (c.error === undefined) throw new Error(`${c.name}: refused, want a plan`);
  return {
    status: c.error.status,
    message: c.error.message,
    fields: logsFieldsOf(c.error.fields),
    ...(c.error.hint === undefined ? {} : { hint: c.error.hint }),
    ...(c.error.planned === undefined ? {} : { planned: logsPlannedOf(c.error.planned) }),
  };
}

function spans(c: LogsPlanCase, tag: 'prepared' | 'planned') {
  return (c.selectors ?? [])
    .filter((s) => s.text === tag)
    .map((s) => ({ from: s.from, to: s.to, reserved: s.reserved }));
}

describe('unit:plan-parity (TS, logs)', () => {
  for (const c of LOGS_FIXTURE.plan) {
    it(c.name, () => {
      const p = prepareLogs(inputsOf(c));
      if (isLogsPlanError(p)) {
        // A preparation failure: only its error.
        expect({ ...p }).toEqual(wantError(c));
        expect(c.substituted).toBeUndefined();
        return;
      }
      if (c.substituted === undefined) throw new Error(`${c.name}: no substituted text`);
      expect(p.substituted).toBe(expand(c.substituted));
      const r = p.plan(c.inputs.step_ms);
      if (isLogsPlanError(r)) {
        expect({ ...r }).toEqual(wantError(c));
        if (c.want !== undefined) {
          // The sent-too-large entries (N8, N10): the route reports that plan.
          const wp = c.want.planned;
          if (wp === undefined || c.error?.planned === undefined) throw new Error(c.name);
          expect(c.want.prepared).toBeUndefined();
          expect(c.want.same_class).toBeUndefined();
          expect(facts(classifyLogs(expand(c.error.planned.query)))).toEqual(wp);
        }
        return;
      }
      if (c.planned === undefined) throw new Error(`${c.name}: planned, want an error`);
      expect(r.planned).toEqual(logsPlannedOf(c.planned));
      for (const [sent, raw] of c.to_source ?? []) {
        expect(r.toSource(sent), `toSource(${String(sent)})`).toBe(raw);
      }
      expect(r.class).toEqual(classifyLogs(r.planned.query));
      if (c.want === undefined) return;
      const gp = facts(p.class);
      const gq = facts(r.class);
      expect(gp).toEqual(c.want.prepared);
      expect(gq).toEqual(c.want.planned);
      expect(JSON.stringify(gp) === JSON.stringify(gq)).toBe(c.want.same_class);
      expect(p.class.selectors).toEqual(spans(c, 'prepared'));
      expect(r.class.selectors).toEqual(spans(c, 'planned'));
    });
  }

  it('volume_range', () => {
    expect(LOGS_FIXTURE.volume_range.length).toBeGreaterThan(0);
    for (const v of LOGS_FIXTURE.volume_range) expect(volumeRange(v.step_ms)).toBe(v.text);
  });

  it('rate_window', () => {
    for (const r of LOGS_FIXTURE.rate_window) {
      expect(logsRateWindowMs(r.step_ms)).toBe(r.window_ms);
      expect(logsFormatDuration(r.window_ms)).toBe(r.text);
    }
  });

  it('durations', () => {
    for (const d of LOGS_FIXTURE.durations) expect(logsFormatDuration(d.ms)).toBe(d.text);
  });

  it('the A.1.4 values are written byte for byte', () => {
    const q = LOGS_FIXTURE.plan.filter((c) => /^Q\d+ /.test(c.name));
    expect(q.length).toBe(11);
    for (const c of q) {
      const p = prepareLogs(inputsOf(c));
      if (isLogsPlanError(p)) {
        expect(c.error?.fields[0]?.message_key, c.name).toBe('variable.unrepresentable');
        continue;
      }
      const r = p.plan(c.inputs.step_ms);
      if (isLogsPlanError(r) || c.planned === undefined) throw new Error(c.name);
      expect(encoder.encode(r.planned.query).length, c.name).toBe(c.planned.bytes);
      expect(r.planned.query, c.name).toBe(expand(c.planned.query));
    }
  });
});

describe('unit:logql-classify', () => {
  for (const e of LOGS_FIXTURE.classify) {
    it(e.name, () => {
      const p = prepareLogs({
        query: expand(e.text),
        vars: e.vars ?? {},
        kind: 'range',
        stepMs: 5000,
      });
      if (isLogsPlanError(p)) throw new Error(`${e.name}: ${p.message}`);
      for (const c of [p.class, classifyLogs(p.substituted)]) {
        expect(c.source).toBe(e.want.class);
        expect(c.reserved).toEqual(e.want.reserved);
        expect(
          c.selectors.map((s) => ({
            reserved: s.reserved,
            text: slice(p.substituted, s.from, s.to),
          })),
        ).toEqual(e.want.selectors.map((s) => ({ reserved: s.reserved, text: expand(s.text) })));
      }
    });
  }

  it('reservedIn over the reserved section', () => {
    expect(LOGS_FIXTURE.reserved.length).toBeGreaterThan(0);
    for (const r of LOGS_FIXTURE.reserved) {
      expect(reservedIn(expand(r.text)), expand(r.text)).toBe(r.want);
    }
  });
});
