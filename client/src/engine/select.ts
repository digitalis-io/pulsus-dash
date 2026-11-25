/** Engine selection (plan #68 C1 §3.5, D-SEL). */
export interface Probe {
  readonly search: string;
  readonly buildFlag: string | undefined;
  readonly isolated: boolean;
  readonly offscreen: boolean;
  readonly webgpu: boolean;
  readonly webgl2: boolean;
  readonly waitAsync: boolean;
  readonly failedThisSession: boolean;
}

export type EngineChoice = { kind: 'canvas2d' } | { kind: 'wasm'; forceT2: boolean };

export function chooseEngine(p: Probe): EngineChoice {
  void p;
  return { kind: 'canvas2d' };
}
