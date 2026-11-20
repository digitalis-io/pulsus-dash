import { describe, expect, it } from 'vitest';
import { pushRecent, readRecent } from './recentBoards';

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => {
      m.clear();
    },
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => {
      m.delete(k);
    },
    setItem: (k, v) => {
      m.set(k, v);
    },
  };
}

const throwing = {
  getItem: () => {
    throw new Error('blocked');
  },
  setItem: () => {
    throw new Error('blocked');
  },
} as unknown as Storage;

describe('recent boards', () => {
  it('moves a revisited board to the front without duplicates', () => {
    const s = memoryStorage();
    pushRecent(s, 'demo', 'b-1');
    pushRecent(s, 'demo', 'b-2');
    expect(pushRecent(s, 'demo', 'b-1')).toEqual(['b-1', 'b-2']);
    expect(readRecent(s, 'demo')).toEqual(['b-1', 'b-2']);
  });
  it('keeps the newest five', () => {
    const s = memoryStorage();
    for (const u of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) pushRecent(s, 'demo', u);
    expect(readRecent(s, 'demo')).toEqual(['g', 'f', 'e', 'd', 'c']);
  });
  it('treats invalid JSON and blocked storage as empty', () => {
    const s = memoryStorage();
    s.setItem('pulsus-dash.recent.demo', '{not json');
    expect(readRecent(s, 'demo')).toEqual([]);
    expect(readRecent(throwing, 'demo')).toEqual([]);
    expect(() => pushRecent(throwing, 'demo', 'b-1')).not.toThrow();
  });
});
