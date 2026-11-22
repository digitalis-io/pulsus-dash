/**
 * Chart colours from the generated tokens only (T01-010, T02-004). A series' colour is a function
 * of its own labels and key (VL-002, T02-005 as amended by #58): the Table 8-1a level colour for a
 * log-level series, else `key_hash mod 8`. State colours are never used for series (VL-003): they
 * reach the marks only through `StateEncoding` (threshold lines and labels, T02-004).
 */
import { colour, sequentialRamp, seriesPalette } from '../../styles/tokens';
import { StateEncoding, type State } from '../../theme/stateEncoding';
import type { ThemeName } from '../api';

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

export interface ThemeColours {
  background: string;
  grid: string;
  axisText: string;
  crosshair: string;
  brush: string;
  /** Behind a value label drawn inside the plot under a band hold (#93): the tooltip surface. */
  chip: string;
  text: string;
  series: readonly string[];
  ramp: readonly string[];
  /** Threshold lines and labels only: `StateEncoding[s].colour[t]` (T02-004, VL-003). */
  state: Readonly<Record<State, string>>;
}

export function themeColours(t: ThemeName): ThemeColours {
  const c = colour[t];
  return {
    background: c['surface-1'],
    grid: c.hairline,
    axisText: c['text-muted'],
    crosshair: c['text-muted'],
    brush: c.brush,
    chip: c['surface-2'],
    text: c.text,
    series: seriesPalette[t],
    ramp: sequentialRamp[t],
    state: {
      ok: StateEncoding.ok.colour[t],
      watch: StateEncoding.watch.colour[t],
      degraded: StateEncoding.degraded.colour[t],
      failing: StateEncoding.failing.colour[t],
      unknown: StateEncoding.unknown.colour[t],
    },
  };
}

/** The ramp step of a heatmap count: none for 0, else min(8, floor(9 · count / max)). */
export function rampIndex(count: number, maxCount: number): number | null {
  if (!(count > 0) || !(maxCount > 0)) return null;
  return Math.min(8, Math.floor((9 * count) / maxCount));
}
