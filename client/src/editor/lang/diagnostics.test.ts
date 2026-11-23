import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/types';
import { positionDiagnostics, utf8ToIndex } from './diagnostics';
import { diagnosticsOf, utf8ToIndex as promUtf8ToIndex } from './promql/promql';

// Plan #66 Part A §3.8: moved from promql.ts unchanged; PromQL re-exports them.
describe('unit:diagnostics-shared', () => {
  it('PromQL re-exports the shared functions', () => {
    expect(diagnosticsOf).toBe(positionDiagnostics);
    expect(promUtf8ToIndex).toBe(utf8ToIndex);
  });

  it('maps a byte offset to the code point that holds it', () => {
    expect(utf8ToIndex('aé😀', 2)).toBe(1);
    expect(utf8ToIndex('aé😀', 4)).toBe(2);
    expect(utf8ToIndex('aé😀', 7)).toBe(4);
    expect(utf8ToIndex('aé😀', 8)).toBeNull();
    const text = 'xé{';
    expect(
      positionDiagnostics(
        text,
        new ApiError('queryInvalid', 'm', { detail: { position: 3 } }),
        (i) => i,
        text,
      ),
    ).toEqual([{ from: 2, to: 3, message: 'm', positionKnown: true }]);
  });
});
