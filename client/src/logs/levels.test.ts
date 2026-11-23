// unit:level-tokens (plan #66 Part B §5.3; VL-002, VL-003, T08-022).
import { describe, expect, it } from 'vitest';
import { LOG_LEVELS } from '../data/logFrame';
import { t } from '../i18n/t';
import { colour } from '../styles/tokens';
import { LEVEL_GLYPH, LEVEL_NAME } from './levels';

const SERIES: Readonly<Record<(typeof LOG_LEVELS)[number], string>> = {
  critical: 'series-6',
  error: 'series-6',
  warn: 'series-2',
  info: 'series-1',
  debug: 'series-5',
  trace: 'series-4',
  unknown: 'series-3',
};
const STATES = ['ok', 'watch', 'degraded', 'failing', 'unknown'] as const;

describe('unit:level-tokens', () => {
  it.each(['dark', 'light'] as const)('level-* are the series hues of VL-002 (%s)', (theme) => {
    const c: Readonly<Record<string, string>> = colour[theme];
    for (const level of LOG_LEVELS) {
      const v = c[`level-${level}`];
      expect(v, level).toBeDefined();
      expect(v, level).toBe(c[SERIES[level]]);
      for (const st of STATES) expect(v, `${level} vs ${st}`).not.toBe(c[st]);
    }
    expect(c['level-critical']).toBe(c['level-error']);
  });

  it('glyphs and names: one per level, the glyphs distinct', () => {
    const glyphs = LOG_LEVELS.map((l) => t(LEVEL_GLYPH[l]));
    expect(glyphs).toEqual(['UNK', 'TRC', 'DBG', 'INF', 'WRN', 'ERR', 'CRT']);
    expect(new Set(glyphs).size).toBe(7);
    expect(LOG_LEVELS.map((l) => t(LEVEL_NAME[l]))).toEqual([
      'Unknown level',
      'Trace',
      'Debug',
      'Info',
      'Warning',
      'Error',
      'Critical',
    ]);
  });
});
