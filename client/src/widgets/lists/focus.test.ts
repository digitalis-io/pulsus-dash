/** Focus repair by key (plan #216 Part 1 §4.3, `unit:list-keyboard` pure leg; T24-025). */
import { describe, expect, it } from 'vitest';
import { B_UIDS } from '../boardList/fixtures';
import { repairActive } from './focus';

describe('unit:list-keyboard (pure)', () => {
  it('repairs the active row by key, then by index', () => {
    const withoutGateway = B_UIDS.filter((k) => k !== 'gateway');
    expect(repairActive('gateway', 3, withoutGateway)).toEqual({
      key: 'inventory',
      index: 3,
      gone: true,
    });
    const edgeAt1 = B_UIDS.filter((k) => k !== 'ck-2');
    expect(edgeAt1[1]).toBe('edge');
    expect(repairActive('edge', 2, edgeAt1)).toEqual({ key: 'edge', index: 1, gone: false });
    const three = B_UIDS.slice(0, 3);
    expect(repairActive('web', 11, three)).toEqual({ key: three[2], index: 2, gone: true });
    expect(repairActive('x', 0, [])).toEqual({ key: null, index: -1, gone: true });
    expect(repairActive(null, 0, [])).toEqual({ key: null, index: -1, gone: false });
    expect(repairActive(null, 0, B_UIDS)).toEqual({ key: 'ck-1', index: 0, gone: false });
  });
});
