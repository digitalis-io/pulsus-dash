/**
 * `unit:board-list-vis` (plan #216 Part 2b §3.1, §5; T24 §5.5, T24-028): the editor's options are
 * written in the head's stored representation, and every import result reads back unchanged.
 */
import { describe, expect, it } from 'vitest';
import { importBoardList } from '../../import/boardList';
import { boardListVis } from './boardListVis';
import { boardListOptions, type BoardListOptions } from './options';

const D: BoardListOptions = { mode: 'starred', query: '', tag: null, limit: 10, sort: 'default' };

describe('unit:board-list-vis', () => {
  it('the defaults with no original are a bare board list', () => {
    expect(boardListVis(D, undefined)).toEqual({ kind: 'boardList' });
    expect(boardListVis(D, { kind: 'boardList' })).toEqual({ kind: 'boardList' });
  });

  it('a search writes its mode and query only', () => {
    expect(boardListVis({ ...D, mode: 'search', query: 'check' }, undefined)).toEqual({
      kind: 'boardList',
      options: { mode: 'search', query: 'check' },
    });
    // An empty query is the default: not written unless the head had it.
    expect(boardListVis({ ...D, mode: 'search' }, undefined)).toEqual({
      kind: 'boardList',
      options: { mode: 'search' },
    });
    expect(
      boardListVis({ ...D, mode: 'search' }, { kind: 'boardList', options: { query: '' } }),
    ).toEqual({ kind: 'boardList', options: { mode: 'search', query: '' } });
  });

  it('a key the head has is kept at its default', () => {
    expect(boardListVis(D, { kind: 'boardList', options: { limit: 10 } })).toEqual({
      kind: 'boardList',
      options: { limit: 10 },
    });
    expect(boardListVis(D, { kind: 'boardList', options: { mode: 'starred' } })).toEqual({
      kind: 'boardList',
      options: { mode: 'starred' },
    });
    expect(boardListVis(D, { kind: 'boardList', options: {} })).toEqual({
      kind: 'boardList',
      options: {},
    });
    expect(boardListVis({ ...D, limit: 20, sort: 'incidents' }, undefined)).toEqual({
      kind: 'boardList',
      options: { limit: 20, sort: 'incidents' },
    });
  });

  it('search → tag drops the query; tag → recent drops the tag', () => {
    const original = {
      kind: 'boardList' as const,
      options: { mode: 'search' as const, query: 'x' },
    };
    expect(boardListVis({ ...D, mode: 'tag', query: 'x', tag: 'a' }, original)).toEqual({
      kind: 'boardList',
      options: { mode: 'tag', tag: 'a' },
    });
    expect(
      boardListVis(
        { ...D, mode: 'recent', tag: 'a' },
        { kind: 'boardList', options: { mode: 'tag', tag: 'a' } },
      ),
    ).toEqual({ kind: 'boardList', options: { mode: 'recent' } });
    // A tag mode without a tag writes none (the live error shows instead).
    expect(boardListVis({ ...D, mode: 'tag' }, undefined)).toEqual({
      kind: 'boardList',
      options: { mode: 'tag' },
    });
  });

  it('every import result reads back unchanged (I1–I9)', () => {
    const sources: readonly Record<string, unknown>[] = [
      {},
      { showStarred: true, showRecentlyViewed: true, maxItems: 80 },
      { showStarred: false, showSearch: true, tags: ['Team-A', 'b c', 'ops'], query: 'x' },
      { showStarred: false, showSearch: true, query: 'a'.repeat(120) },
      { showStarred: 'yes', maxItems: 'many', keepTime: false, folderUID: 'abc' },
      { showStarred: false, showRecentlyViewed: false, showSearch: false },
      { showStarred: false, showSearch: true, tags: ['!!'] },
      { showRecentlyViewed: false, query: 'x', maxItems: 0 },
      { showStarred: false, showSearch: true, query: 'a\tb\u0007c' },
    ];
    for (const src of sources) {
      const o = importBoardList(src).options;
      expect(boardListOptions(boardListVis(o, undefined).options), JSON.stringify(src)).toEqual(o);
      const shown = boardListVis(o, undefined);
      expect(boardListOptions(boardListVis(o, shown).options)).toEqual(o);
    }
    expect(boardListVis(importBoardList({}).options, undefined)).toEqual({ kind: 'boardList' });
  });
});
