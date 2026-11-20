import { describe, expect, it } from 'vitest';
import { applyTheme, readThemePref, resolveTheme, THEME_KEY } from './theme';

function storageWith(v: string | null): Storage {
  return { getItem: (k: string) => (k === THEME_KEY ? v : null) } as unknown as Storage;
}
const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('theme', () => {
  it('defaults to dark for missing, invalid and blocked storage', () => {
    expect(readThemePref(storageWith(null))).toBe('dark');
    expect(readThemePref(storageWith('purple'))).toBe('dark');
    expect(readThemePref(throwing)).toBe('dark');
    expect(readThemePref(null)).toBe('dark');
    expect(readThemePref(storageWith('light'))).toBe('light');
  });
  it('resolves system from the media preference', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
  });
  it('applies the theme to the root element', () => {
    applyTheme('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
