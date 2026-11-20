// Stub for the tests-first commit: the implementation follows.
/**
 * The BFF client. Until the BFF and its OpenAPI document exist (#59, ADR-0015) every method rejects
 * with `ApiError('notImplemented')`, so `VITE_API_MODE=http` shows the session error page.
 */
import type { Api } from './Api';

import { type BoardSummary, type Session } from './types';

export class HttpApi implements Api {
  getSession(): Promise<Session> {
    throw new Error('not implemented');
  }

  listBoards(): Promise<BoardSummary[]> {
    throw new Error('not implemented');
  }

  getBoard(): Promise<BoardSummary> {
    throw new Error('not implemented');
  }

  listStarred(): Promise<string[]> {
    throw new Error('not implemented');
  }

  setStarred(): Promise<string[]> {
    throw new Error('not implemented');
  }

  signOut(): Promise<void> {
    throw new Error('not implemented');
  }
}
