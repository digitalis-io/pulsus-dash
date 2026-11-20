import type { Api } from './Api';
import { HttpApi } from './HttpApi';
import { StubApi } from './StubApi';

export type { Api } from './Api';
export { HttpApi } from './HttpApi';
export { StubApi, type StubSeed } from './StubApi';
export * from './types';

export function createApi(mode: 'stub' | 'http' = import.meta.env.VITE_API_MODE ?? 'stub'): Api {
  return mode === 'http' ? new HttpApi() : new StubApi();
}
