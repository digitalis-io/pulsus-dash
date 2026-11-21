/**
 * Seeded synthetic panel data for the stub (plan #61 Part B Appendix B-A §A.2): a pure function of
 * the panel and the window, so a panel shows the same chart on every render and in every test.
 */
import { hash01, LEVELS, synthHeatmap, synthLevels, synthLines } from '../dev/synth';
import { t } from '../i18n/t';
import type { PanelData, PanelSpec, TimeWindow } from './types';

/** FNV-1a, 32-bit, over the UTF-16 code units of `s`. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const HEATMAP_BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, Infinity];

export function stubPanelData(panel: PanelSpec, window: TimeWindow): PanelData {
  const seed = fnv1a(`${panel.id}:${panel.query.text}`);
  const title = panel.title === '' ? t('panel.untitled') : panel.title;
  const kind =
    panel.vis.kind === 'auto' ? (panel.query.lang === 'promql' ? 'line' : 'bars') : panel.vis.kind;
  const { fromMs, toMs } = window;
  switch (kind) {
    case 'logs':
      return { kind: 'noVis' };
    case 'line':
      return {
        kind: 'frame',
        spec: { kind: 'line', title, unit: { kind: 'suffix', suffix: 'rps' } },
        data: {
          kind: 'series',
          series: synthLines({
            seed,
            series: 3,
            points: 360,
            fromMs,
            toMs,
            name: 'panel',
            base: 100,
            amp: 30,
          }),
        },
      };
    case 'bars':
      return {
        kind: 'frame',
        spec: {
          kind: 'bars',
          title,
          unit: { kind: 'suffix', suffix: 'lines' },
          stacking: 'normal',
          categoryLabel: 'level',
          categoryOrder: LEVELS,
        },
        data: {
          kind: 'series',
          series: synthLevels({ seed, fromMs, toMs, buckets: 60, levels: LEVELS }),
        },
      };
    case 'heatmap':
      return {
        kind: 'frame',
        spec: {
          kind: 'heatmap',
          title,
          unit: { kind: 'time', base: 's' },
          countUnit: { kind: 'none' },
        },
        data: {
          kind: 'heatmap',
          heatmap: synthHeatmap({ seed, fromMs, toMs, columns: 60, bounds: HEATMAP_BOUNDS }),
        },
      };
    case 'stat':
      return {
        kind: 'frame',
        spec: { kind: 'stat', title, unit: { kind: 'time', base: 'ms' } },
        data: {
          kind: 'scalar',
          scalar: { value: 100 + Math.round(900 * hash01(seed)), timestampMs: toMs },
        },
      };
  }
}
