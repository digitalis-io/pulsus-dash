// Stub for the tests-first commit: the implementation follows.
import type { BoardSummary } from '../api/types';

export function useBoards(
  tenant: string,
): import('@tanstack/react-query').UseQueryResult<BoardSummary[], Error> {
  throw new Error('not implemented');
}

export function useStarred(
  tenant: string,
): import('@tanstack/react-query').UseQueryResult<string[], Error> {
  throw new Error('not implemented');
}

export function SidebarBoards(): import('react').JSX.Element {
  throw new Error('not implemented');
}
