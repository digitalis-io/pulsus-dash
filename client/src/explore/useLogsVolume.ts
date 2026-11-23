/**
 * The log volume of Explore › Logs (plan #66 Part C §3.7; SRF-033, PRF-030): the URL text sent as
 * is (ADR-0021 §2) with the window and the step's width, as one TanStack query under the
 * `['data']` prefix: a newer key aborts the older request, and the shell's refresh cancels and
 * reruns it. The last success of the tenant is kept (D-RUN).
 */
import type { VolumeResult } from '../data/decode';
import type { StepWidth } from './stepWidth';

/** `['data', 'logs', 'volume', tenant, q, fromMs, toMs, stepMs]`: under the shell's refresh rule. */
export function logsVolumeKey(
  tenant: string,
  q: string,
  w: { readonly fromMs: number; readonly toMs: number },
  stepMs: number,
): readonly unknown[] {
  return ['data', 'logs', 'volume', tenant, q, w.fromMs, w.toMs, stepMs];
}

export interface LogsVolume {
  /** The last success of this tenant (D-RUN); null when `q` is ''. */
  readonly shown: VolumeResult | null;
  /** The current key's error; null when none or an `AbortError`. */
  readonly error: unknown;
  readonly fetching: boolean;
  /** Cancels the key's request in flight, then fetches again. */
  rerun(): void;
}

export function useLogsVolume(_a: {
  readonly tenant: string;
  readonly q: string;
  readonly window: { readonly fromMs: number; readonly toMs: number };
  readonly step: StepWidth | null;
  /** q not blank, no refusal, step known. */
  readonly enabled: boolean;
}): LogsVolume {
  throw new Error('not implemented');
}
