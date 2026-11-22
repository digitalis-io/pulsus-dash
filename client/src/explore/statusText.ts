/**
 * The texts of the Explore status line (plan #63 Part C §3.2, §4.2): a run error as the user reads
 * it, with whether Narrow helps; the outcome of a run; the two Run refusals (T09-015, B.8 #12).
 */
import { isApiError } from '../api/types';
import type { Diagnostic } from '../editor/lang/types';
import { formatValue } from '../i18n/format';
import { t } from '../i18n/t';
import type { Refusal, RunOutcome } from './useExploreRun';

export interface ErrorView {
  readonly text: string;
  /** The error is about the size of the window: offer Narrow. */
  readonly narrow: boolean;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Null for no error and for an `AbortError`; the §4.2 table otherwise. */
export function errorView(error: unknown, diagnostics: readonly Diagnostic[]): ErrorView | null {
  if (error === null || error === undefined) return null;
  if (error instanceof DOMException && error.name === 'AbortError') return null;
  const plain = (text: string, narrow = false): ErrorView => ({ text, narrow });
  if (!isApiError(error)) return plain(`${t('explore.error.unknown')}: ${messageOf(error)}`);
  switch (error.kind) {
    case 'queryInvalid':
      return plain(diagnostics[0]?.message ?? error.message);
    case 'tooBroad':
      return plain(error.message, true);
    case 'timeout':
      return plain(t('explore.error.timeout'), true);
    case 'busy':
      return plain(t('explore.error.busy'));
    case 'unavailable':
      return plain(`${t('explore.error.unavailable')}: ${error.message}`);
    case 'network':
      return plain(t('explore.error.network'));
    case 'notFound':
      return plain(t('explore.error.notFound'));
    case 'queryTooLong':
      // The server's 413 on the planned text (plan #112 §3.10): the 64 KiB text, no Narrow.
      return plain(refusalText('tooLong'));
    default:
      return plain(`${t('explore.error.unknown')}: ${error.message}`);
  }
}

const ms = (v: number): string => formatValue(v, { kind: 'time', base: 'ms' });

/** `{count} series · step {step} · {duration}`, and the instant, scalar and string forms. */
export function outcomeText(o: RunOutcome): string {
  const duration = ms(o.durationMs);
  const r = o.result;
  switch (r.kind) {
    case 'scalar':
      return t('explore.status.scalar', { duration });
    case 'string':
      return t('explore.status.string', { duration });
    case 'series':
      return r.stepMs === null
        ? t('explore.status.instant', { count: r.series.length, duration })
        : t('explore.status.range', { count: r.series.length, step: ms(r.stepMs), duration });
  }
}

export function refusalText(r: Refusal): string {
  return r === 'queryTooLarge' ? t('explore.error.queryTooLarge') : t('explore.error.tooLong');
}
