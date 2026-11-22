/**
 * Main-thread long tasks of a scripted interaction, from a Chromium trace (#90, plan Appendix B
 * §B.1; PRF-005, T05 §4.3). `bench:rooms-long-tasks` runs it over the room scenarios: every task
 * over 16 ms wall is reported, and CI's interim trace check counts those over 50 ms wall with over
 * 16 ms thread time (a task without thread time counts: the check fails closed). The `inputs` option
 * and the per-type `counts` serve the chart-gesture scenario (#93).
 */
export interface TraceEvent {
  name: string;
  ph: string;
  ts: number;
  dur?: number;
  tdur?: number;
  pid: number;
  tid: number;
  args?: { name?: string; data?: { type?: string } };
}

export interface LongTask {
  /** Trace time of the task's start, µs. */
  tsUs: number;
  durMs: number;
  /** Thread (CPU) time; null when the trace has none for this task. */
  threadMs: number | null;
  /** The last `step:*` mark at or before the task, without `step:`; else `unlabelled`. */
  label: string;
}

export interface LongTaskResult {
  clicks: number;
  keydowns: number;
  /** From the first input's start to the last input's end. */
  windowMs: number;
  /** Every `RunTask` over 16 ms wall in the window, by start. */
  tasks: LongTask[];
  /** `tasks.length`: the reference lab's check. */
  over16: number;
  /** Tasks over 50 ms wall with over 16 ms (or unknown) thread time: T05 §4.3's interim CI check. */
  ciOver: number;
  /** The longest task's wall time, 0 when none. */
  worstMs: number;
  /** EventDispatch count per input type in the window. */
  counts: Readonly<Record<string, number>>;
}

/** #90's input list, unchanged. */
export const DEFAULT_INPUTS = [
  'click',
  'keydown',
  'keyup',
  'keypress',
  'pointerdown',
  'pointerup',
  'mousedown',
  'mouseup',
  'input',
] as const;
/** Chart gestures (#93): #90's list plus wheel, moves, context menu and double-click. */
export const CHART_INPUTS = [
  ...DEFAULT_INPUTS,
  'wheel',
  'pointermove',
  'mousemove',
  'contextmenu',
  'dblclick',
] as const;

const LONG_US = 16_000;
const CI_WALL_MS = 50;
const CI_THREAD_MS = 16;

const threadKey = (e: { pid: number; tid: number }): string => `${String(e.pid)}:${String(e.tid)}`;

/** `inputs`: the `EventDispatch` types that open and close the window (default `DEFAULT_INPUTS`). */
export function longTasks(
  events: readonly TraceEvent[],
  o: { inputs?: readonly string[] } = {},
): LongTaskResult {
  const types = new Set<string>(o.inputs ?? DEFAULT_INPUTS);
  const renderers = new Set(
    events
      .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args?.name === 'CrRendererMain')
      .map(threadKey),
  );
  // The renderer main thread with the most input dispatches is the page's.
  const dispatches = new Map<string, number>();
  for (const e of events) {
    if (e.name !== 'EventDispatch') continue;
    const k = threadKey(e);
    if (renderers.has(k)) dispatches.set(k, (dispatches.get(k) ?? 0) + 1);
  }
  let main: string | null = null;
  let most = -1;
  for (const k of renderers) {
    const n = dispatches.get(k) ?? 0;
    if (n > most) {
      most = n;
      main = k;
    }
  }
  if (main === null) throw new Error('no renderer main thread');
  const onMain = events.filter((e) => threadKey(e) === main);

  const inputs = onMain
    .filter((e) => e.name === 'EventDispatch' && types.has(e.args?.data?.type ?? ''))
    .sort((a, b) => a.ts - b.ts);
  const first = inputs[0];
  if (first === undefined) throw new Error('no input');
  const start = first.ts;
  const end = Math.max(...inputs.map((e) => e.ts + (e.dur ?? 0)));
  const counts: Record<string, number> = {};
  for (const e of inputs) {
    const t = e.args?.data?.type ?? '';
    counts[t] = (counts[t] ?? 0) + 1;
  }
  const typeCount = (t: string): number => counts[t] ?? 0;

  const inWindow = onMain.filter(
    (e) => e.ph === 'X' && e.name === 'RunTask' && e.ts < end && e.ts + (e.dur ?? 0) > start,
  );
  if (!inWindow.some((e) => e.tdur !== undefined)) throw new Error('no thread time');

  const steps = onMain.filter((e) => e.name.startsWith('step:')).sort((a, b) => a.ts - b.ts);
  const labelAt = (ts: number): string => {
    let label = 'unlabelled';
    for (const s of steps) if (s.ts <= ts) label = s.name.slice('step:'.length);
    return label;
  };

  const tasks: LongTask[] = inWindow
    .filter((e) => (e.dur ?? 0) > LONG_US)
    .sort((a, b) => a.ts - b.ts)
    .map((e) => ({
      tsUs: e.ts,
      durMs: (e.dur ?? 0) / 1000,
      threadMs: e.tdur === undefined ? null : e.tdur / 1000,
      label: labelAt(e.ts),
    }));
  const ciOver = tasks.filter(
    (x) => x.durMs > CI_WALL_MS && (x.threadMs === null || x.threadMs > CI_THREAD_MS),
  ).length;
  return {
    clicks: typeCount('click'),
    keydowns: typeCount('keydown'),
    windowMs: (end - start) / 1000,
    tasks,
    over16: tasks.length,
    ciOver,
    worstMs: tasks.reduce((m, x) => Math.max(m, x.durMs), 0),
    counts,
  };
}
