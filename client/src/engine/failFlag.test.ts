import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A fresh module each test: the flag lives in module memory for the page (plan #68 C1 §4.3). */
async function load(): Promise<typeof import('./failFlag')> {
  vi.resetModules();
  return import('./failFlag');
}

const KEY = 'pulsus-dash.engine-failed';

describe('engine failure flag (T03-025)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a throwing storage reads as not failed, and marking still holds for the page', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const f = await load();
    expect(f.sessionFailed()).toBe(false);
    expect(() => {
      f.markSessionFailed();
    }).not.toThrow();
    expect(f.sessionFailed()).toBe(true);
  });

  it('working storage keeps the flag for the session', async () => {
    const f = await load();
    expect(f.sessionFailed()).toBe(false);
    f.markSessionFailed();
    expect(sessionStorage.getItem(KEY)).toBe('1');
    expect(f.sessionFailed()).toBe(true);
    // A reload (a fresh module) reads it back.
    const g = await load();
    expect(g.sessionFailed()).toBe(true);
  });
});
