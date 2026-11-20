import { describe, expect, it } from 'vitest';
import { messages } from '../i18n/messages.en-GB';
import { t } from '../i18n/t';
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
});
