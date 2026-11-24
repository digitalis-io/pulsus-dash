// unit:query-language (plan #67 §5.1): a null language loads nothing.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetQueryLanguages, useQueryLanguage } from './useQueryLanguage';

const calls = vi.hoisted(() => ({ logql: 0 }));
vi.mock('../editor/lang/index', async (importOriginal) => {
  const m = await importOriginal<typeof import('../editor/lang/index')>();
  return {
    ...m,
    LANGUAGES: Object.freeze({
      ...m.LANGUAGES,
      logql: () => {
        calls.logql += 1;
        return m.LANGUAGES.logql();
      },
    }),
  };
});

beforeEach(() => {
  calls.logql = 0;
  resetQueryLanguages();
});

describe('unit:query-language', () => {
  it('null: loading, and no import', async () => {
    const { result } = renderHook(() => useQueryLanguage(null));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(result.current).toEqual({ lang: null, failed: false });
    expect(calls.logql).toBe(0);
  });

  it('logql: one import', async () => {
    const { result } = renderHook(() => useQueryLanguage('logql'));
    await vi.waitFor(() => {
      expect(result.current.lang).not.toBeNull();
    });
    expect(calls.logql).toBe(1);
  });
});
