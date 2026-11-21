/**
 * The metric picker's options (plan #63 Part C §3.2; SRF-031 subset): names that contain the filter
 * (case-insensitive), those starting with it first, each by code units, capped at
 * `PICKER_OPTIONS`; each described by its metadata type and help, or its base name's.
 */
import type { PromMetadata } from '../data/decode';
import { t } from '../i18n/t';
import { kindOfType, metricKind } from './metricKind';

export const PICKER_OPTIONS = 100;

export interface MetricOption {
  readonly name: string;
  readonly description: string;
}

const SUFFIXES = ['_bucket', '_count', '_sum', '_total'] as const;
const byCodeUnits = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function helpOf(name: string, meta: PromMetadata['metrics']): string {
  const own = meta[name]?.[0]?.help;
  if (own !== undefined && own !== '') return own;
  for (const s of SUFFIXES) {
    if (!name.endsWith(s)) continue;
    const base = meta[name.slice(0, -s.length)]?.[0]?.help;
    if (base !== undefined && base !== '') return base;
  }
  return '';
}

function describe(name: string, meta: PromMetadata['metrics']): string {
  const k = metricKind(name, (n) =>
    Object.hasOwn(meta, n) ? kindOfType(meta[n]?.[0]?.type) : null,
  );
  const type = k === 'unknown' ? '' : k;
  const help = helpOf(name, meta);
  if (type !== '' && help !== '') return t('explore.picker.description', { type, help });
  return type || help;
}

export function metricOptions(
  names: readonly string[],
  meta: PromMetadata['metrics'],
  filter: string,
): { readonly options: MetricOption[]; readonly total: number } {
  const f = filter.trim().toLowerCase();
  const matches = f === '' ? [...names] : names.filter((n) => n.toLowerCase().includes(f));
  const starts = (n: string) => n.toLowerCase().startsWith(f);
  matches.sort((a, b) => Number(starts(b)) - Number(starts(a)) || byCodeUnits(a, b));
  return {
    options: matches
      .slice(0, PICKER_OPTIONS)
      .map((name) => ({ name, description: describe(name, meta) })),
    total: matches.length,
  };
}
