/** Stub (#90, tests first). */
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
  tsUs: number;
  durMs: number;
  threadMs: number | null;
  label: string;
}
export interface LongTaskResult {
  clicks: number;
  keydowns: number;
  windowMs: number;
  tasks: LongTask[];
  over16: number;
  ciOver: number;
  worstMs: number;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub until the implementation
export function longTasks(events: readonly TraceEvent[]): LongTaskResult {
  return { clicks: 0, keydowns: 0, windowMs: 0, tasks: [], over16: 0, ciOver: 0, worstMs: 0 };
}
