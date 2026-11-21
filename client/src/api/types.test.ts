import { describe, expect, it } from 'vitest';
import { ApiError, BoardConflictError, isApiError, type ApiErrorKind, type Board } from './types';

const BOARD: Board = {
  uid: 'b-1',
  title: 'B',
  version: 2,
  updatedAt: '2026-11-21T12:00:00Z',
  updatedBy: 'Local user',
  etag: '2',
  spec: { title: 'B', panels: [], sections: [] },
};

describe('ApiError: one class for every kind family', () => {
  it('common kinds carry no fields and no detail', () => {
    const common: ApiErrorKind[] = [
      'notFound',
      'unauthorised',
      'network',
      'notImplemented',
      'unknown',
    ];
    for (const kind of common) {
      const e = new ApiError(kind, 'm');
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe('ApiError');
      expect(e.kind).toBe(kind);
      expect(e.message).toBe('m');
      expect(e.fields).toEqual([]);
      expect(e.detail).toEqual({});
      expect(isApiError(e, kind)).toBe(true);
    }
  });

  it('board kinds: invalid carries its fields, conflict is BoardConflictError', () => {
    const fields = [{ pointer: '/title', messageKey: 'board.title.required' }];
    const invalid = new ApiError('invalid', 'invalid board', { fields });
    expect(invalid.fields).toEqual(fields);
    expect(invalid.detail).toEqual({});
    expect(isApiError(invalid, 'invalid')).toBe(true);

    const conflict = new BoardConflictError(BOARD);
    expect(conflict).toBeInstanceOf(ApiError);
    expect(conflict.name).toBe('BoardConflictError');
    expect(conflict.kind).toBe('conflict');
    expect(conflict.message).toBe('board changed since it was read');
    expect(conflict.current).toBe(BOARD);
    expect(conflict.fields).toEqual([]);
    expect(isApiError(conflict, 'conflict')).toBe(true);
  });

  it('query kinds carry what the BFF said in detail', () => {
    const query: ApiErrorKind[] = [
      'queryInvalid',
      'tooBroad',
      'timeout',
      'unavailable',
      'busy',
      'badResponse',
    ];
    for (const kind of query) {
      const detail = { queryId: 'q1', position: 3, hint: { reason: 'r' } };
      const e = new ApiError(kind, 'm', { detail });
      expect(e.kind).toBe(kind);
      expect(e.detail).toEqual(detail);
      expect(e.fields).toEqual([]);
      expect(isApiError(e, kind)).toBe(true);
      expect(isApiError(e, 'notFound')).toBe(false);
      expect(new ApiError(kind, 'm').detail).toEqual({});
    }
  });
});
