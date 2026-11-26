/** `csvCell` (T24-026 amended, T22-013; plan #173 Part 1 `unit:category-table`). */
import { describe, expect, it } from 'vitest';
import { csvCell } from './csv';

describe('unit:category-table (csvCell)', () => {
  it('RFC 4180 quoting', () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell('ok')).toBe('ok');
    expect(csvCell('')).toBe('');
    expect(csvCell('1\n')).toBe('"1\n"');
  });

  it('the formula guard and the numeric exemption', () => {
    expect(csvCell('=1')).toBe("'=1");
    expect(csvCell('=SUM(1)')).toBe("'=SUM(1)");
    expect(csvCell('@x')).toBe("'@x");
    expect(csvCell('-1+2')).toBe("'-1+2");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe('"\'\rx"');
    // A number is exempt only as the whole cell, with no line terminator.
    expect(csvCell('-1\n')).toBe('"\'-1\n"');
    expect(csvCell('-1 ')).toBe("'-1 ");
    expect(csvCell('1 ')).toBe('1 ');
    for (const v of ['+1', '-Infinity', '+Infinity', '-6.25', '1e5', '-1', '42'])
      expect(csvCell(v), v).toBe(v);
  });
});
