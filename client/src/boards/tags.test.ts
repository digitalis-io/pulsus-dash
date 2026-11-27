/** `unit:board-tags-pure` (plan #216 Part 2b §3.2, §5; T24-029): adding typed or pasted tags. */
import { describe, expect, it } from 'vitest';
import { addTags, tagError } from './tags';

const SIXTEEN = Array.from({ length: 16 }, (_, i) => `t${String(i)}`);

describe('unit:board-tags-pure', () => {
  it('lower-cases, splits on commas and white space, and adds in order', () => {
    expect(addTags([], 'Team:Payments')).toEqual({
      tags: ['team:payments'],
      rest: '',
      problem: null,
    });
    expect(addTags([], 'a, b c')).toEqual({ tags: ['a', 'b', 'c'], rest: '', problem: null });
  });

  it('stops at the first piece that fails and leaves it and the rest in the input', () => {
    expect(addTags(['a'], 'b a c')).toEqual({
      tags: ['a', 'b'],
      rest: 'a, c',
      problem: 'duplicate',
    });
    expect(addTags([], 'Bad Tag!')).toEqual({ tags: ['bad'], rest: 'tag!', problem: 'invalid' });
    expect(addTags(SIXTEEN, 'x')).toEqual({ tags: SIXTEEN, rest: 'x', problem: 'full' });
  });

  it('empty pieces change nothing', () => {
    expect(addTags([], ' , ')).toEqual({ tags: [], rest: '', problem: null });
    expect(addTags(['a'], '')).toEqual({ tags: ['a'], rest: '', problem: null });
  });

  it('tagError picks the first error at /tags or one of its items', () => {
    const f = { pointer: '/tags/3', messageKey: 'board.tags.invalid' };
    expect(
      tagError([
        { pointer: '/title', messageKey: 'board.title.required' },
        f,
        { ...f, pointer: '/tags' },
      ]),
    ).toEqual(f);
    expect(tagError([{ pointer: '/tagsx', messageKey: 'board.json.unknownKey' }])).toBeNull();
    expect(tagError([{ pointer: '/tags', messageKey: 'board.json.unknownKey' }])).toEqual({
      pointer: '/tags',
      messageKey: 'board.json.unknownKey',
    });
  });
});
