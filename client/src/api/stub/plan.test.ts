/**
 * unit:plan-parity (TS, plan #112 §5.2): the StubApi planner mirror runs every case of the shared
 * fixture along the stub path (`prepare`, `classify`, `floorStep`, `expandedAt`, `stubShape`,
 * `plan`) and gives the Go planner's results; and the fixture's tables.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadMirror } from './varsCore';
import { expand, expandedOf, fieldsOf, FIXTURE, plannedOf, type FixtureCase } from './planFixture';
import {
  __test,
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
import { promGrid } from '../../data/step';
import { stubShape } from './promShape';

function inputsOf(c: FixtureCase) {
  return {
    query: expand(c.inputs.query),
    vars: c.inputs.vars,
    kind: c.inputs.kind,
    stepMs: c.inputs.step_ms,
    rate: c.inputs.rate,
    ...(c.inputs.range_ms === undefined ? {} : { rangeMs: c.inputs.range_ms }),
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

// The structured-value cases need the rest of the mirror (plan #289), loaded on demand.
beforeAll(async () => {
  await loadMirror();
});

describe('unit:plan-parity (TS)', () => {
  // A case only the server's probe guard refuses is the server's (plan #289 §3.4).
  for (const c of FIXTURE.plan.filter((x) => x.server_only !== true)) {
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
      if (isPlanError(e)) {
        // The step macros at the resolved step crossed the processing cap (N18c): the shape is
        // the placeholder text's.
        expect(c.error?.hint?.reason).toBe('processing_cap');
        expect(p.needsTypes(stubShape(p.substituted)), 'needsTypes').toBe(c.needs_types);
      } else expect(p.needsTypes(stubShape(e)), 'needsTypes').toBe(c.needs_types);
      const outcome = (x: StubPlanned | StubPlanError) => (isPlanError(x) ? x : x.planned);
      if (!c.needs_types) expect(outcome(run(c, {}))).toEqual(outcome(r));
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

  it('repeated references are measured once per value and state (review r1, r2)', () => {
    const vars = { a: '\n'.repeat(4096) };
    const refuse = (query: string) => {
      __test.valueReads = 0;
      const p = prepare({ query, vars, kind: 'range', stepMs: 5000, rate: true });
      if (!isPlanError(p)) throw new Error('prepared');
      return p;
    };
    // 1 000 references in one "…" string: 8 192 000 encoded bytes, one (value, state) pair.
    expect(refuse('x{a="' + '$a'.repeat(1000) + '"}').hint).toEqual({ reason: 'processing_cap' });
    expect(__test.valueReads).toBe(1);
    // A comment and a "…" string: two pairs; the comment value is refused first (row 7b).
    const e = refuse('x{a="' + '$a'.repeat(1000) + '"} # $a');
    expect(e.fields).toEqual([{ pointer: '/vars/a', messageKey: 'variable.unrepresentable' }]);
    expect(__test.valueReads).toBe(2);
  });

  it('bytes', () => {
    for (const b of FIXTURE.bytes) expect(utf8Length(expand(b.text))).toBe(b.bytes);
  });
});

describe('unit:promql-step acceptance (#303)', () => {
  // #303 acceptance, as Go's TestStepAndWindow303.
  it.each([
    ['6 h at 560 px', 21_600_000, 560, 30_000, 60_000],
    ['15 min at 1 200 px', 900_000, 1200, 15_000, 60_000],
    ['1 h at 1 200 px', 3_600_000, 1200, 15_000, 60_000],
    ['24 h at 1 000 px', 86_400_000, 1000, 60_000, 75_000],
    ['30 d at 560 px', 2_592_000_000, 560, 3_600_000, 3_615_000],
  ])('%s: step and rate window', (_, span, w, step, window) => {
    const to = 1_767_225_600_000;
    const g = promGrid(to - span, to, w);
    expect(g?.stepMs).toBe(step);
    expect(rateWindowMs(step)).toBe(window);
  });
});
