/** The input ring's producer (TODO C2a1: stub). */
import type { CameraState } from './frame';

export interface InputRec {
  readonly seq: number;
  readonly kind: number;
  readonly frame: number;
  readonly tMs: number;
  readonly f: readonly (number | null)[];
}

export interface RingOptions {
  readonly firstSeq?: number;
  readonly log?: boolean;
  readonly now?: () => number;
}

export const extendSeq = (_p: number, a: number): number => a;

export class InputRing {
  readonly stats = { coalesced: 0, publishedBytes: 0 };
  produced: InputRec[] | null = null;

  constructor(
    readonly memory: WebAssembly.Memory,
    readonly cb: number,
    readonly wake: () => void,
    readonly o: RingOptions = {},
  ) {}

  camera(_frame: number, _c: CameraState): void {
    // TODO C2a1.
  }

  resize(_frame: number, _cssW: number, _cssH: number, _dpr: number): void {
    // TODO C2a1.
  }

  onPublish(_frame: number, _cb: (kind: number, seq: number) => void): void {
    // TODO C2a1.
  }

  unpublished(_frame: number): number {
    return 0;
  }

  drop(_frame: number): void {
    // TODO C2a1.
  }

  flush(): void {
    // TODO C2a1.
  }
}
