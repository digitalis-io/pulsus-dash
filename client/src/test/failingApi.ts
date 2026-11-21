/** A `StubApi` whose named methods reject once per queued error, then behave normally. */
import { StubApi, type StubSeed } from '../api/StubApi';
import type { ApiError } from '../api/types';

type Method =
  | 'createBoard'
  | 'saveBoard'
  | 'deleteBoard'
  | 'getBoard'
  | 'listBoards'
  | 'listStarred'
  | 'setStarred'
  | 'listRecent'
  | 'recordView';

export class FailingApi extends StubApi {
  readonly calls: { method: Method; args: unknown[] }[] = [];

  constructor(
    private readonly failures: Partial<Record<Method, ApiError[]>>,
    seed?: StubSeed,
  ) {
    super(seed);
  }

  private fail(method: Method, args: unknown[]): ApiError | undefined {
    this.calls.push({ method, args });
    return this.failures[method]?.shift();
  }

  override createBoard(...args: Parameters<StubApi['createBoard']>) {
    const e = this.fail('createBoard', args);
    return e === undefined ? super.createBoard(...args) : Promise.reject(e);
  }

  override saveBoard(...args: Parameters<StubApi['saveBoard']>) {
    const e = this.fail('saveBoard', args);
    return e === undefined ? super.saveBoard(...args) : Promise.reject(e);
  }

  override deleteBoard(...args: Parameters<StubApi['deleteBoard']>) {
    const e = this.fail('deleteBoard', args);
    return e === undefined ? super.deleteBoard(...args) : Promise.reject(e);
  }

  override getBoard(...args: Parameters<StubApi['getBoard']>) {
    const e = this.fail('getBoard', args);
    return e === undefined ? super.getBoard(...args) : Promise.reject(e);
  }

  override listBoards(...args: Parameters<StubApi['listBoards']>) {
    const e = this.fail('listBoards', args);
    return e === undefined ? super.listBoards(...args) : Promise.reject(e);
  }

  override listStarred(...args: Parameters<StubApi['listStarred']>) {
    const e = this.fail('listStarred', args);
    return e === undefined ? super.listStarred(...args) : Promise.reject(e);
  }

  override setStarred(...args: Parameters<StubApi['setStarred']>) {
    const e = this.fail('setStarred', args);
    return e === undefined ? super.setStarred(...args) : Promise.reject(e);
  }

  override listRecent(...args: Parameters<StubApi['listRecent']>) {
    const e = this.fail('listRecent', args);
    return e === undefined ? super.listRecent(...args) : Promise.reject(e);
  }

  override recordView(...args: Parameters<StubApi['recordView']>) {
    const e = this.fail('recordView', args);
    return e === undefined ? super.recordView(...args) : Promise.reject(e);
  }
}

/** Shorthand: `failingApi({ saveBoard: [new ApiError('network', 'x')] })`. */
export function failingApi(
  failures: Partial<Record<Method, ApiError[]>>,
  seed?: StubSeed,
): FailingApi {
  return new FailingApi(failures, seed);
}
