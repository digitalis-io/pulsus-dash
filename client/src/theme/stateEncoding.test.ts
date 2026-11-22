import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/messages.en-GB';
import { t } from '../i18n/t';
import { colour } from '../styles/tokens';
import { StateEncoding } from './stateEncoding';

describe('state encoding', () => {
  it('encodes the five states with glyph, class and label', () => {
    expect(Object.keys(StateEncoding)).toEqual(['ok', 'watch', 'degraded', 'failing', 'unknown']);
    const styles = Object.values(StateEncoding);
    expect(styles.map((s) => s.glyph).join('')).toBe('●◐◉■○');
    const classes = styles.map((s) => s.className);
    for (const c of classes) expect(c).not.toBe('');
    expect(new Set(classes).size).toBe(5);
    for (const s of styles) {
      expect(s.label in messages).toBe(true);
      expect(t(s.label)).not.toBe('');
    }
  });

  it('each state has a distinct glyph and its token colour per theme', () => {
    const states = ['ok', 'watch', 'degraded', 'failing', 'unknown'] as const;
    expect(new Set(states.map((s) => StateEncoding[s].glyph)).size).toBe(5);
    for (const s of states) {
      for (const theme of ['dark', 'light'] as const) {
        expect(StateEncoding[s].colour[theme], `${s} ${theme}`).toBe(colour[theme][s]);
      }
    }
  });
});
