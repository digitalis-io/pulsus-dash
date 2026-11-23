/** The client log buffer (plan #66 Part B §3.2). Stub: implemented in the next commit. */
import type { LogFrame, LogStreamInfo } from '../data/logFrame';

export const MAX_ENTRIES = 1_000_000;
/** Line text held, in UTF-16 code units (Q3: about 256 MiB). */
export const MAX_TEXT_UNITS = 2 ** 27;

export interface OrdRange {
  readonly from: number;
  readonly to: number;
}

export interface LogRow {
  readonly ord: number;
  readonly tsNs: bigint;
  readonly level: number;
  readonly line: string;
  readonly stream: LogStreamInfo;
  readonly wrapUnits: number;
  readonly breaks: number;
}

export interface PageResult {
  readonly frame: LogFrame;
  readonly cursor: string | null;
}

export type AcceptOutcome = 'first' | 'appended' | 'prepended' | 'drift' | 'stale';

export interface BufferCaps {
  readonly entries?: number;
  readonly textUnits?: number;
}

const notImplemented = (): never => {
  throw new Error('not implemented');
};

export class LogBuffer {
  constructor(caps?: BufferCaps) {
    void caps;
  }
  get firstOrd(): number {
    return notImplemented();
  }
  get endOrd(): number {
    return notImplemented();
  }
  get length(): number {
    return notImplemented();
  }
  get textUnits(): number {
    return notImplemented();
  }
  get headPage(): number {
    return notImplemented();
  }
  get tailPage(): number {
    return notImplemented();
  }
  get knownPages(): number {
    return notImplemented();
  }
  get exhausted(): boolean {
    return notImplemented();
  }
  get total(): number | null {
    return notImplemented();
  }
  cursorOf(k: number): string | null | undefined {
    void k;
    return notImplemented();
  }
  rowAt(ord: number): LogRow | null {
    void ord;
    return notImplemented();
  }
  accept(k: number, page: PageResult, protect: OrdRange | null): AcceptOutcome {
    void k;
    void page;
    void protect;
    return notImplemented();
  }
}

export function wrapLines(row: Pick<LogRow, 'wrapUnits' | 'breaks'>, perLine: number): number {
  void row;
  void perLine;
  return notImplemented();
}

export function pageFingerprint(frame: LogFrame): string {
  void frame;
  return notImplemented();
}
