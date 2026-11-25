/** The engine backend: boot, workers and the restart policy (plan #68 C1 §4). */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener(type: string, cb: (e: unknown) => void): void;
}

export interface EngineOptions {
  readonly forceT2: boolean;
  readonly markFailed: () => void;
  readonly compile?: () => Promise<WebAssembly.Module>;
  readonly spawnRender?: () => WorkerLike;
  readonly spawnPool?: () => WorkerLike;
  readonly timeoutMs?: number;
}

export function loadBackend(o: EngineOptions): Promise<never> {
  void o;
  return Promise.reject(new Error('stub'));
}
