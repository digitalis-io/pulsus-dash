/**
 * The BFF client. Until the BFF and its OpenAPI document exist (#59, ADR-0015) every method rejects
 * with `ApiError('notImplemented')`, so `VITE_API_MODE=http` shows the session error page.
 */
import type { Api } from './Api';
import { ApiError, type BoardSummary, type Session } from './types';

function notImplemented<T>(what: string): Promise<T> {
  return Promise.reject(new ApiError('notImplemented', `${what}: the BFF client is not built yet`));
}

export class HttpApi implements Api {
  getSession(): Promise<Session> {
    return notImplemented('getSession');
  }

  listBoards(): Promise<BoardSummary[]> {
    return notImplemented('listBoards');
  }

  getBoard(): Promise<BoardSummary> {
    return notImplemented('getBoard');
  }

  listStarred(): Promise<string[]> {
    return notImplemented('listStarred');
  }

  setStarred(): Promise<string[]> {
    return notImplemented('setStarred');
  }

  signOut(): Promise<void> {
    return notImplemented('signOut');
  }
}
