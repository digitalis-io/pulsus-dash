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

describe('markOnFailure (plan #256 §3.2, §4.2)', () => {
  it('marks the session on a rejection and rethrows; never for EngineAbsent or a value', async () => {
    const f = await load();
    const mark = vi.fn();
    const fail = f.markOnFailure(() => Promise.reject(new Error('x')), mark);
    await expect(fail()).rejects.toThrow('x');
    expect(mark).toHaveBeenCalledTimes(1);

    const absentMark = vi.fn();
    const absent = f.markOnFailure(
      () =>
        Promise.reject(
          Object.assign(new Error('the engine is not in this build'), { name: 'EngineAbsent' }),
        ),
      absentMark,
    );
    await expect(absent()).rejects.toThrow('the engine is not in this build');
    expect(absentMark).toHaveBeenCalledTimes(0);

    const okMark = vi.fn();
    const ok = f.markOnFailure((n: number) => Promise.resolve(n * 2), okMark);
    await expect(ok(21)).resolves.toBe(42);
    expect(okMark).toHaveBeenCalledTimes(0);
  });

  it('marks the session flag by default', async () => {
    const f = await load();
    await expect(f.markOnFailure(() => Promise.reject(new Error('y')))()).rejects.toThrow('y');
    expect(f.sessionFailed()).toBe(true);
    expect(sessionStorage.getItem(KEY)).toBe('1');
  });
});
