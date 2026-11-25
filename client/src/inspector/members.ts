/**
 * Member lists of an Inspector target (T25-011): texts and runs, each showing at most
 * `MEMBERS_SHOWN` with its own "+k more"; the first press resolves the full lists once.
 */
import type { State } from '../theme/stateEncoding';

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
}

export interface MemberSection {
  readonly texts: { readonly shown: readonly string[]; readonly count: number };
  readonly runs: { readonly shown: readonly MemberFacts[]; readonly count: number } | null;
  /** Null = the lists are complete. */
  readonly resolve: { readonly panelId: string; readonly runId: string } | null;
}

export interface MembersState {
  readonly result: { readonly texts: string[]; readonly runs: MemberFacts[] } | 'stale' | null;
  readonly textsOpen: boolean;
  readonly runsOpen: boolean;
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

export function expandMembers(
  m: MemberSection,
  r: MemberList | null,
): { texts: string[]; runs: MemberFacts[] } | 'stale' {
  void m;
  void r;
  throw new Error('todo');
}

export function membersView(
  m: MemberSection,
  s: MembersState,
): { texts: ListView<string>; runs: ListView<MemberFacts> | null; stale: boolean } {
  void m;
  void s;
  throw new Error('todo');
}

export function pressMore(
  m: MemberSection,
  s: MembersState,
  l: 'texts' | 'runs',
  resolve: (panelId: string, runId: string) => MemberList | null,
): MembersState {
  void m;
  void s;
  void l;
  void resolve;
  throw new Error('todo');
}

export function pressFewer(s: MembersState, l: 'texts' | 'runs'): MembersState {
  void s;
  void l;
  throw new Error('todo');
}
