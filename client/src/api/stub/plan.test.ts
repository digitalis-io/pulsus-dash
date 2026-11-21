/**
 * unit:plan-parity (TS, plan #112 §5.2): the StubApi planner mirror runs every case of the shared
 * fixture along the stub path (`prepare`, `classify`, `floorStep`, `expandedAt`, `stubShape`,
 * `plan`) and gives the Go planner's results; and the fixture's tables.
 */
import { describe, expect, it } from 'vitest';
import { expand, expandedOf, fieldsOf, FIXTURE, plannedOf, type FixtureCase } from './planFixture';
import {
  floorStep,
  formatDuration,
  isPlanError,
  kindOf,
  prepare,
  rateWindowMs,
  reservedIn,
  typesFromMetadata,
  utf8Length,
  type StubPlanError,
  type StubPlanned,
} from './plan';
import { stubShape } from './promShape';

function inputsOf(c: FixtureCase) {
  return {
    query: expand(c.inputs.query),
    vars: c.inputs.vars,
    kind: c.inputs.kind,
    stepMs: c.inputs.step_ms,
    rate: c.inputs.rate,
  };
}

/** The stub path of plan §3.9 / A.11 without I/O: the plan or the refusal of a case. */
function run(c: FixtureCase, types = c.types): StubPlanned | StubPlanError {
  const p = prepare(inputsOf(c));
  if (isPlanError(p)) return p;
  const cls = p.classify(stubShape(p.substituted));
  const step = floorStep(c.inputs.step_ms, cls.floorMs);
  const e = p.expandedAt(step);
  if (isPlanError(e)) return e;
  return p.plan(step, stubShape(e), types);
}

function expectResult(c: FixtureCase, r: StubPlanned | StubPlanError): void {
  if (c.planned !== undefined) {
    if (isPlanError(r)) throw new Error(`${c.name}: refused: ${r.message}`);
    expect(r.planned).toEqual(plannedOf(c.planned));
  } else if (c.error !== undefined) {
    if (!isPlanError(r)) throw new Error(`${c.name}: planned ${r.planned.query.slice(0, 80)}`);
    const want: StubPlanError = {
      status: c.error.status,
      message: c.error.message,
      fields: fieldsOf(c.error.fields),
      ...(c.error.hint === undefined ? {} : { hint: c.error.hint }),
      ...(c.error.planned === undefined ? {} : { planned: plannedOf(c.error.planned) }),
    };
    expect({ ...r }).toEqual(want);
  } else throw new Error(`${c.name}: neither planned nor error`);
}

describe('unit:plan-parity (TS)', () => {
  for (const c of FIXTURE.plan) {
    it(c.name, () => {
      const r = run(c);
      expectResult(c, r);
      for (const [sent, raw] of c.to_source ?? []) {
        const p = isPlanError(r) ? null : r;
        if (p === null) throw new Error(`${c.name}: to_source of a refusal`);
        expect(p.toSource(sent), `toSource(${String(sent)})`).toBe(raw);
      }
      const p = prepare(inputsOf(c));
      if (c.needs_types === undefined) {
        expect(isPlanError(p)).toBe(true);
        return;
      }
      if (isPlanError(p)) throw new Error(`${c.name}: prepare refused: ${p.message}`);
      const cls = p.classify(stubShape(p.substituted));
      expect(cls).toEqual(
        c.classify === undefined
          ? { source: 'pulsus_db', reserved: [], floorMs: 0 }
          : {
              source: c.classify.source,
              reserved: c.classify.reserved,
              floorMs: c.classify.floor_ms,
            },
      );
      if (c.resolve !== undefined) {
        expect(floorStep(c.resolve.grid_step_ms, cls.floorMs)).toBe(c.resolve.step_ms);
        expect(c.resolve.step_ms).toBe(c.inputs.step_ms);
      }
      const step = floorStep(c.inputs.step_ms, cls.floorMs);
      const e = p.expandedAt(step);
      if (isPlanError(e)) throw new Error(`${c.name}: expandedAt refused`);
      expect(p.needsTypes(stubShape(e)), 'needsTypes').toBe(c.needs_types);
      if (!c.needs_types) expect(run(c, {})).toEqual(r);
    });
  }

  it('groups have one planned query each', () => {
    const groups = new Map<string, Set<string>>();
    for (const c of FIXTURE.plan) {
      if (c.group === undefined || c.planned === undefined) continue;
      const g = groups.get(c.group) ?? new Set<string>();
      g.add(expand(c.planned.query));
      groups.set(c.group, g);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const g of groups.values()) expect(g.size).toBe(1);
  });

  it('the shape of every case is recorded with a plan', () => {
    for (const c of FIXTURE.plan) {
      if (c.shape !== undefined) expect(expandedOf(c), c.name).not.toBeNull();
    }
  });

  it('kind_of', () => {
    for (const k of FIXTURE.kind_of) expect(kindOf(k.name, k.types), k.name).toBe(k.want);
  });

  it('from_metadata', () => {
    for (const m of FIXTURE.from_metadata) expect(typesFromMetadata(m.metadata)).toEqual(m.types);
  });

  it('rate_window', () => {
    for (const r of FIXTURE.rate_window) {
      expect(rateWindowMs(r.step_ms)).toBe(r.window_ms);
      expect(formatDuration(r.window_ms)).toBe(r.text);
    }
  });

  it('durations', () => {
    for (const d of FIXTURE.durations) expect(formatDuration(d.ms)).toBe(d.text);
  });

  it('G4: reservedIn over the reserved section (A.11)', () => {
    expect(FIXTURE.reserved.length).toBeGreaterThan(0);
    for (const r of FIXTURE.reserved)
      expect(reservedIn(expand(r.text)), expand(r.text)).toBe(r.want);
  });

  it('bytes', () => {
    for (const b of FIXTURE.bytes) expect(utf8Length(expand(b.text))).toBe(b.bytes);
  });
});
