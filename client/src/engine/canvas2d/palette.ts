/**
 * Chart colours from the generated tokens only (T01-010, T02-004). A series' colour is a function
 * of its own labels and key (VL-002, T02-005 as amended by #58): the Table 8-1a level colour for a
 * log-level series, else `key_hash mod 8`. State colours are never used for series (VL-003): they
 * reach the marks only through `StateEncoding` (threshold lines and labels, T02-004).
 */
import { colour, opacity, sequentialRamp, seriesPalette } from '../../styles/tokens';
import { StateEncoding, type State } from '../../theme/stateEncoding';
import type { ThemeName } from '../api';

// The series colour index lives in a module without the token CSS, so the e2e specs import it too
// (#173 Part 3b).
export { LEVEL_COLOUR, LEVEL_LABELS, seriesColourIndex } from './seriesColour';

export interface ThemeColours {
  background: string;
  grid: string;
  axisText: string;
  crosshair: string;
  brush: string;
  /** Behind a value label drawn inside the plot under a band hold (#93): the tooltip surface. */
  chip: string;
  text: string;
  /** Event lines (ADR-0023): `text-muted`, never a state colour (T02-004). */
  event: string;
  /** The bar chart's baseline ghost (ADR-0028): `text-muted`. */
  ghost: string;
  /** The selection underlay and rings (ADR-0025, T25-006). */
  focus: string;
  /** The selection band: `accent` at 16 % (T25-006). */
  selection: string;
  /** The alpha of unselected marks while a selection is relevant (T25-006). */
  dimmed: number;
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
    event: c['text-muted'],
    ghost: c['text-muted'],
    focus: c.focus,
    selection: c.selection,
    dimmed: opacity.dimmed,
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
