import { describe, expect, it } from 'vitest';
import { CONTEXT_ROWS, caretOf } from '../../../test/logqlContextCases';
import { caretContext } from './context';

// Appendix A.3 of plan #66 Part A. `‸` marks the caret and is removed before the call.
describe('unit:logql-context', () => {
  for (const [id, marked, expected] of CONTEXT_ROWS) {
    it(`${id}: ${marked}`, () => {
      const { text, pos } = caretOf(marked);
      expect(caretContext(text, pos)).toEqual(expected);
    });
  }
});
