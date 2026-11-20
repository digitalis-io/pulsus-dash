// Stub for the tests-first commit: the implementation follows.
import type { Api } from './Api';

export type { Api } from './Api';

export { HttpApi } from './HttpApi';

export { StubApi, type StubSeed } from './StubApi';

export * from './types';

export function createApi(mode?: 'stub' | 'http'): Api {
  throw new Error('not implemented');
}
