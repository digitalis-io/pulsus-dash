import type { Plugin } from 'vite';

export interface DashEngineOptions {
  /** client/, with a trailing slash. */
  readonly root: string;
  /** Default `process.env`. Reads VITE_ENGINE_PROBE and VITEST. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Default `existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/** Test-first stub (plan #256 §5). */
export function dashEngine(_o: DashEngineOptions): Plugin {
  return { name: 'dash-engine' };
}

/** Test-first stub (plan #256 §5). */
export function engineAbsentMessage(_probe: boolean): string {
  return '';
}
