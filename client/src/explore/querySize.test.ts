import { describe, expect, it } from 'vitest';
import { overQueryLimit, QUERY_BYTE_LIMIT, queryBytes } from './querySize';

// B.4.7 of plan #63 Part B (T09-015).
describe('unit:query-size', () => {
  const rows: [string, string, number, boolean][] = [
    ['Q1', 'a'.repeat(131_071), 131_071, false],
    ['Q2', 'a'.repeat(131_072), 131_072, false],
    ['Q3', 'a'.repeat(131_073), 131_073, true],
    ['Q4', 'あ'.repeat(43_691), 131_073, true],
    ['Q5', 'あ'.repeat(43_690), 131_070, false],
    ['Q5 + ab', 'あ'.repeat(43_690) + 'ab', 131_072, false],
    ['Q5 + abc', 'あ'.repeat(43_690) + 'abc', 131_073, true],
    ['Q6', '😀'.repeat(32_768), 131_072, false],
    ['Q6 + 1', '😀'.repeat(32_769), 131_076, true],
  ];
  for (const [name, text, bytes, over] of rows) {
    it(name, () => {
      expect(QUERY_BYTE_LIMIT).toBe(131_072);
      expect(queryBytes(text)).toBe(bytes);
      expect(overQueryLimit(text)).toBe(over);
    });
  }
});
