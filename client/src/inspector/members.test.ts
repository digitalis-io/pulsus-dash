// unit:inspector-members (T25-011, T25 §10, plan #192 §5).
import { describe, expect, it } from 'vitest';
import {
  membersView,
  NO_MEMBERS_STATE,
  pressFewer,
  pressMore,
  type MemberFacts,
  type MemberList,
  type MemberSection,
} from './members';

const text = (i: number): string => `text ${String(i)}`;
const run = (i: number): MemberFacts => ({
  fromMs: i * 1_000,
  toMs: (i + 1) * 1_000,
  text: `run ${String(i)}`,
  state: null,
});
const range = (n: number) => Array.from({ length: n }, (_, i) => i);

const SECTION: MemberSection = {
  texts: { shown: range(8).map(text), count: 10 },
  runs: { shown: range(8).map(run), count: 12 },
  resolve: { panelId: 'P2', runId: 'P2:K:r0' },
};

const FULL: MemberList = { texts: range(10).map(text), members: range(12).map(run) };

describe('unit:inspector-members', () => {
  it('(a) each list has its own "+k more" and resolves once', () => {
    const v0 = membersView(SECTION, NO_MEMBERS_STATE);
    expect(v0.texts.items).toHaveLength(8);
    expect(v0.texts.more).toBe(2);
    expect(v0.runs?.more).toBe(4);
    expect(v0.stale).toBe(false);
    let calls = 0;
    const resolve = (panelId: string, runId: string): MemberList | null => {
      calls += 1;
      expect([panelId, runId]).toEqual(['P2', 'P2:K:r0']);
      return FULL;
    };
    const s1 = pressMore(SECTION, NO_MEMBERS_STATE, 'runs', resolve);
    const v1 = membersView(SECTION, s1);
    expect(v1.runs?.items).toHaveLength(12);
    expect(v1.runs?.fewer).toBe(true);
    expect(v1.runs?.more).toBeNull();
    expect(v1.texts.items).toHaveLength(8);
    expect(v1.texts.more).toBe(2);
    const s2 = pressMore(SECTION, s1, 'texts', resolve);
    expect(membersView(SECTION, s2).texts.items).toHaveLength(10);
    expect(calls).toBe(1);
    const s3 = pressFewer(s2, 'runs');
    expect(membersView(SECTION, s3).runs?.items).toHaveLength(8);
    expect(membersView(SECTION, s3).runs?.more).toBe(4);
    expect(membersView(SECTION, s3).texts.items).toHaveLength(10);
  });

  it('(b) a null result is stale: both keep 8, no buttons', () => {
    const s = pressMore(SECTION, NO_MEMBERS_STATE, 'texts', () => null);
    expect(s.result).toBe('stale');
    const v = membersView(SECTION, s);
    expect(v.stale).toBe(true);
    expect(v.texts.items).toHaveLength(8);
    expect(v.runs?.items).toHaveLength(8);
    expect(v.texts.more).toBeNull();
    expect(v.runs?.more).toBeNull();
  });

  it('(c) a mismatched result is stale', () => {
    const short: MemberList = { texts: range(10).map(text), members: range(11).map(run) };
    const s = pressMore(SECTION, NO_MEMBERS_STATE, 'runs', () => short);
    expect(s.result).toBe('stale');
    const v = membersView(SECTION, s);
    expect(v.stale).toBe(true);
    expect(v.texts.items).toHaveLength(8);
    expect(v.runs?.items).toHaveLength(8);
    expect(v.runs?.more).toBeNull();
  });

  it('a new target resets the state; runs of 0 are omitted', () => {
    const s = pressMore(SECTION, NO_MEMBERS_STATE, 'runs', () => FULL);
    expect(membersView(SECTION, s).runs?.items).toHaveLength(12);
    expect(membersView(SECTION, NO_MEMBERS_STATE).runs?.items).toHaveLength(8);
    const noRuns: MemberSection = { ...SECTION, runs: { shown: [], count: 0 } };
    expect(membersView(noRuns, NO_MEMBERS_STATE).runs).toBeNull();
  });

  it('complete lists (no resolve) open without a resolver call', () => {
    const complete: MemberSection = {
      texts: { shown: range(10).map(text), count: 10 },
      runs: null,
      resolve: null,
    };
    const v0 = membersView(complete, NO_MEMBERS_STATE);
    expect(v0.texts.items).toHaveLength(8);
    expect(v0.texts.more).toBe(2);
    const s = pressMore(complete, NO_MEMBERS_STATE, 'texts', () => {
      throw new Error('no resolve for complete lists');
    });
    expect(membersView(complete, s).texts.items).toHaveLength(10);
  });
});
