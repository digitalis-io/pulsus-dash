/**
 * Member lists of an Inspector target (T25-011): texts and runs, each showing at most
 * `MEMBERS_SHOWN` with its own "+k more"; the first press resolves the full lists once.
 */
import type { State } from '../theme/stateEncoding';
import type { Labels } from './types';

export const MEMBERS_SHOWN = 8;

export interface MemberFacts {
  readonly fromMs: number;
  readonly toMs: number;
  readonly text: string;
  readonly state: State | null;
}

export interface MemberList {
  readonly texts: readonly string[];
  readonly members: readonly MemberFacts[];
  /** Parallel to `texts`: each entry's labels, for its own chips (T25-009, #154). */
  readonly labels?: readonly Labels[];
}

export interface MemberSection {
  readonly texts: {
    readonly shown: readonly string[];
    readonly count: number;
    /** Parallel to `shown`: each entry's labels, for its own chips (T25-009, #154). */
    readonly labels?: readonly Labels[];
  };
  readonly runs: { readonly shown: readonly MemberFacts[]; readonly count: number } | null;
  /** Null = the lists are complete. */
  readonly resolve: { readonly panelId: string; readonly runId: string } | null;
}

export interface MembersState {
  readonly result: Expanded | 'stale' | null;
  readonly textsOpen: boolean;
  readonly runsOpen: boolean;
}

/** The resolved lists; `labels` parallel to `texts`, null when the section has none. */
export interface Expanded {
  readonly texts: string[];
  readonly runs: MemberFacts[];
  readonly labels: Labels[] | null;
}

export interface ListView<T> {
  readonly items: readonly T[];
  /** "+k more": k, or null without a button. */
  readonly more: number | null;
  /** "Show fewer" shows. */
  readonly fewer: boolean;
}

export const NO_MEMBERS_STATE: MembersState = Object.freeze({
  result: null,
  textsOpen: false,
  runsOpen: false,
});

/**
 * The full lists, once resolved: complete iff texts.length = textCount, members.length =
 * memberCount and, when labels are given, labels.length = texts.length; a null or incomplete
 * result is stale (T25-011). The labels stay parallel to the texts (#154): the resolved list's,
 * else none.
 */
export function expandMembers(m: MemberSection, r: MemberList | null): Expanded | 'stale' {
  if (r === null) return 'stale';
  if (r.texts.length !== m.texts.count || r.members.length !== (m.runs?.count ?? 0)) {
    return 'stale';
  }
  if (r.labels !== undefined && r.labels.length !== r.texts.length) return 'stale';
  return {
    texts: [...r.texts],
    runs: [...r.members],
    labels: r.labels === undefined ? null : [...r.labels],
  };
}

function listView<T>(
  shown: readonly T[],
  count: number,
  full: readonly T[] | null,
  open: boolean,
  stale: boolean,
): ListView<T> {
  if (open && full !== null) return { items: full, more: null, fewer: true };
  const items = shown.slice(0, MEMBERS_SHOWN);
  const k = count - items.length;
  return { items, more: stale || k <= 0 ? null : k, fewer: false };
}

/** What each list shows for `s`: ≤ 8 with its own "+k more", or all with "Show fewer". */
export function membersView(
  m: MemberSection,
  s: MembersState,
): {
  texts: ListView<string>;
  /** Parallel to `texts.items`; null when the section has no labels (#154). */
  labels: readonly Labels[] | null;
  runs: ListView<MemberFacts> | null;
  stale: boolean;
} {
  const stale = s.result === 'stale';
  const full = s.result === null || s.result === 'stale' ? null : s.result;
  const texts = listView(m.texts.shown, m.texts.count, full?.texts ?? null, s.textsOpen, stale);
  const runs =
    m.runs === null || m.runs.count === 0
      ? null
      : listView(m.runs.shown, m.runs.count, full?.runs ?? null, s.runsOpen, stale);
  const labels = texts.fewer
    ? (full?.labels ?? null)
    : (m.texts.labels?.slice(0, texts.items.length) ?? null);
  return { texts, labels, runs, stale };
}

/**
 * "+k more" on list `l`: the first press resolves once (`resolve` for a run, the shown lists when
 * they are complete); the list then shows everything.
 */
export function pressMore(
  m: MemberSection,
  s: MembersState,
  l: 'texts' | 'runs',
  resolve: (panelId: string, runId: string) => MemberList | null,
): MembersState {
  let result = s.result;
  if (result === null) {
    const r =
      m.resolve === null
        ? {
            texts: m.texts.shown,
            members: m.runs?.shown ?? [],
            ...(m.texts.labels === undefined ? {} : { labels: m.texts.labels }),
          }
        : resolve(m.resolve.panelId, m.resolve.runId);
    result = expandMembers(m, r);
  }
  if (result === 'stale') return { ...s, result };
  return l === 'texts' ? { ...s, result, textsOpen: true } : { ...s, result, runsOpen: true };
}

/** "Show fewer" on list `l`: back to 8 and its "+k more". */
export function pressFewer(s: MembersState, l: 'texts' | 'runs'): MembersState {
  return l === 'texts' ? { ...s, textsOpen: false } : { ...s, runsOpen: false };
}
