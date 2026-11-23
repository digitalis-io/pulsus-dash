import { describe, expect, it } from 'vitest';
import { CHART_INPUTS, DEFAULT_INPUTS, longTasks, type TraceEvent } from './longTasks.ts';

const MAIN = { pid: 1, tid: 2 };
const OTHER = { pid: 3, tid: 4 };

const thread = (at: { pid: number; tid: number }): TraceEvent => ({
  name: 'thread_name',
  ph: 'M',
  ts: 0,
  ...at,
  args: { name: 'CrRendererMain' },
});
const input = (type: string, ts: number, at = MAIN): TraceEvent => ({
  name: 'EventDispatch',
  ph: 'X',
  ts,
  dur: 1_000,
  tdur: 900,
  ...at,
  args: { data: { type } },
});
const task = (ts: number, durMs: number, threadMs?: number, at = MAIN): TraceEvent => ({
  name: 'RunTask',
  ph: 'X',
  ts,
  dur: durMs * 1_000,
  ...(threadMs === undefined ? {} : { tdur: threadMs * 1_000 }),
  ...at,
});
const step = (label: string, ts: number): TraceEvent => ({
  name: `step:${label}`,
  ph: 'R',
  ts,
  ...MAIN,
});

/** Appendix B §B.2: a renderer main thread with 3 clicks, 1 keydown and six tasks; another thread. */
const TRACE: TraceEvent[] = [
  thread(MAIN),
  thread(OTHER),
  task(0, 100, 100),
  input('click', 200_000),
  step('a', 210_000),
  task(220_000, 10, 9),
  task(240_000, 17, 16),
  input('click', 300_000),
  step('b', 310_000),
  task(320_000, 60, 20),
  task(400_000, 70, 10),
  input('click', 500_000),
  task(510_000, 55),
  input('keydown', 600_000),
  input('click', 250_000, OTHER),
  task(260_000, 90, 90, OTHER),
];

describe('longTasks', () => {
  it('counts the inputs and the long tasks of the renderer main thread', () => {
    const r = longTasks(TRACE);
    expect(r.clicks).toBe(3);
    expect(r.keydowns).toBe(1);
    expect(r.windowMs).toBe(401);
    expect(r.over16).toBe(4);
    expect(r.ciOver).toBe(2);
    expect(r.worstMs).toBe(70);
    expect(r.tasks.map((x) => x.label)).toEqual(['a', 'b', 'b', 'b']);
    expect(r.tasks.map((x) => [x.durMs, x.threadMs])).toEqual([
      [17, 16],
      [60, 20],
      [70, 10],
      [55, null],
    ]);
  });

  it('throws without a renderer main thread', () => {
    expect(() => longTasks(TRACE.filter((e) => e.name !== 'thread_name'))).toThrow(
      'no renderer main thread',
    );
  });

  it('throws when the window has no thread time', () => {
    const bare = TRACE.map((e) => {
      if (e.name !== 'RunTask') return e;
      const rest = { ...e };
      delete rest.tdur;
      return rest;
    });
    expect(() => longTasks(bare)).toThrow('no thread time');
  });
});

describe('longTasks options (#93)', () => {
  // Wheels and moves before the first click: only the chart inputs open the window there.
  const CHART: TraceEvent[] = [
    ...TRACE,
    input('wheel', 100_000),
    input('wheel', 120_000),
    input('pointermove', 150_000),
    task(110_000, 30, 25),
  ];

  it('the default inputs start the window at the first click', () => {
    const r = longTasks(CHART);
    expect(r.windowMs).toBe(401);
    expect(r.over16).toBe(4);
    expect(r.counts['click']).toBe(3);
    expect(r.counts['wheel']).toBeUndefined();
    expect(longTasks(CHART, { inputs: DEFAULT_INPUTS })).toEqual(r);
  });

  it('the chart inputs start it at the first wheel and count each type', () => {
    expect(CHART_INPUTS).toEqual(
      expect.arrayContaining(['wheel', 'pointermove', 'mousemove', 'contextmenu', 'dblclick']),
    );
    const r = longTasks(CHART, { inputs: CHART_INPUTS });
    expect(r.windowMs).toBe(501);
    expect(r.over16).toBe(5);
    expect(r.tasks[0]?.label).toBe('unlabelled');
    expect(r.counts).toMatchObject({ wheel: 2, pointermove: 1, click: 3, keydown: 1 });
    expect(r.clicks).toBe(3);
  });
});

// unit:long-task-marks (plan #66 Part B, B.3): the window between two User Timing marks.
describe('unit:long-task-marks', () => {
  const mark = (name: string, ts: number): TraceEvent => ({ name, ph: 'R', ts, ...MAIN });
  const WHEELS: TraceEvent[] = [
    thread(MAIN),
    mark('bench:start', 0),
    input('wheel', 0),
    task(10_000, 5, 4),
    input('wheel', 99_000),
    task(300_000, 30, 28),
    mark('bench:end', 400_000),
  ];

  it('M1 with marks: a task after the last input counts', () => {
    const r = longTasks(WHEELS, {
      inputs: ['wheel', 'scroll'],
      marks: { start: 'bench:start', end: 'bench:end' },
    });
    expect(r.windowMs).toBe(400);
    expect(r.over16).toBe(1);
    expect(r.counts['wheel']).toBe(2);
  });

  it('M2 without marks: unchanged', () => {
    const r = longTasks(WHEELS, { inputs: ['wheel', 'scroll'] });
    expect(r.windowMs).toBe(100);
    expect(r.over16).toBe(0);
  });

  it('a missing mark is an error naming it', () => {
    expect(() =>
      longTasks(WHEELS, { inputs: ['wheel'], marks: { start: 'bench:start', end: 'bench:nope' } }),
    ).toThrow('bench:nope');
  });
});
