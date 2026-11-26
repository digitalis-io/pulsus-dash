/** `__dashProbe` (TODO C2a1: stub). */
import type { DrawnEvent, FrameSummary, TimeWindow, VisSpec } from '../engine/api';
import type { Backend, ProbeHost } from '../engine/wasm/engine';
import type { InputRec } from '../engine/wasm/ring';

export interface ProbeFrame {
  readonly spec: VisSpec;
  readonly series: readonly { key: string; t: readonly number[]; v: readonly number[] }[];
  readonly w: TimeWindow;
  readonly size: readonly [number, number];
  readonly dpr?: number;
}

export interface DashProbe {
  frame(o: ProbeFrame): Promise<number>;
  call(n: number, m: 'setSpec' | 'setData' | 'setTimeWindow' | 'resize', arg: unknown): void;
  settle(n: number): Promise<void>;
  last(n: number): FrameSummary | null;
  drawn(n: number): DrawnEvent[];
  idle(): boolean;
  inputLog(): Promise<InputRec[]>;
  producedLog(): InputRec[];
  stats(): { coalesced: number; overflow: number; publishedBytes: number };
  counters(): { head: number; tail: number };
}

export function createProbe(_o: {
  backend: () => Promise<Backend>;
  host: () => ProbeHost | null;
}): DashProbe {
  return {
    frame: () => Promise.resolve(0),
    call: () => undefined,
    settle: () => new Promise(() => undefined),
    last: () => null,
    drawn: () => [],
    idle: () => false,
    inputLog: () => Promise.resolve([]),
    producedLog: () => [],
    stats: () => ({ coalesced: 0, overflow: 0, publishedBytes: 0 }),
    counters: () => ({ head: 0, tail: 0 }),
  };
}
