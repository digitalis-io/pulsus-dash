// The LogQL modules of Explore › Logs (plan #66 Part C §3.5); the rejection is LP20.
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLogqlModules } from './useLogqlModules';

describe('useLogqlModules', () => {
  it('loads the LogQL language and the editor chunk', async () => {
    const { result } = renderHook(() => useLogqlModules());
    expect(result.current).toEqual({
      lang: null,
      editor: null,
      failed: false,
      editorFailed: false,
    });
    await waitFor(() => {
      expect(result.current.lang?.lang).toBe('logql');
      expect(result.current.editor?.LogQLEditor).toBeTypeOf('function');
    });
    expect(result.current.editor?.createLogSource).toBeTypeOf('function');
    expect(result.current.failed).toBe(false);
  });
});
