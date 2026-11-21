import { describe, expect, it } from 'vitest';
import { longTasks, type TraceEvent } from './longTasks.ts';

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
