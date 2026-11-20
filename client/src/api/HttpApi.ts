/**
 * The BFF client. Until the BFF and its OpenAPI document exist (#59, ADR-0015) every method rejects
 * with `ApiError('notImplemented')`, so `VITE_API_MODE=http` shows the session error page.
 */
import createClient, { type Client } from 'openapi-fetch';
import type { Api } from './Api';
import type { paths } from './gen/schema';
import { ApiError, type BoardSummary, type Session } from './types';

function notImplemented<T>(what: string): Promise<T> {
  return Promise.reject(new ApiError('notImplemented', `${what}: the BFF client is not built yet`));
}

export class HttpApi implements Api {
  constructor(private readonly client: Client<paths> = createClient<paths>({ baseUrl: '' })) {}

  getSession(_signal?: AbortSignal): Promise<Session> {
    return notImplemented('getSession');
  }

  listBoards(_tenant: string, _signal?: AbortSignal): Promise<BoardSummary[]> {
    return notImplemented('listBoards');
  }

  getBoard(_tenant: string, _uid: string, _signal?: AbortSignal): Promise<BoardSummary> {
    return notImplemented('getBoard');
  }

  listStarred(_tenant: string, _signal?: AbortSignal): Promise<string[]> {
    return notImplemented('listStarred');
  }

  setStarred(_tenant: string, _uid: string, _starred: boolean): Promise<string[]> {
    return notImplemented('setStarred');
  }

  signOut(): Promise<void> {
    return notImplemented('signOut');
  }
}
