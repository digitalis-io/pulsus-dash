/**
 * A series' colour index (VL-002, T02-005 as amended by #58): the Table 8-1a level colour for a
 * log-level series, else `key_hash mod 8`. Pure, with no token CSS: `palette.ts` re-exports it, and
 * the e2e specs import it (#173 Part 3b).
 */

/** Labels that carry a log level, in precedence order. */
export const LEVEL_LABELS = ['level', 'detected_level'] as const;

/** Table 8-1a: lower-case level value → series colour index (0 = series-1). */
export const LEVEL_COLOUR: Readonly<Record<string, number>> = Object.freeze({
  error: 5,
  err: 5,
  critical: 5,
  crit: 5,
  fatal: 5,
  alert: 5,
  emergency: 5,
  warn: 1,
  warning: 1,
  info: 0,
  informational: 0,
  notice: 0,
  debug: 4,
  trace: 3,
  // A volume series of lines without a level (#66 Part C; Table 8-1a 1.4-rc).
  unknown: 2,
});

/** 0..7: the series-N token index of the series. */
export function seriesColourIndex(s: {
  key: string;
  labels: Readonly<Record<string, string>>;
}): number {
  for (const label of LEVEL_LABELS) {
    const v = s.labels[label];
    if (v === undefined) continue;
    const i = LEVEL_COLOUR[v.toLowerCase()];
    if (i !== undefined) return i;
    break;
  }
  // key_hash mod 8: the low three bits of the last hex digit.
  return parseInt(s.key.at(-1) ?? '0', 16) & 7;
}
