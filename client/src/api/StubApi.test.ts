import { describe, expect, it } from 'vitest';
import { StubApi } from './StubApi';
import { ApiError } from './types';

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof ApiError ? e.kind : e instanceof DOMException ? e.name : 'other';
  }
}

describe('stub api', () => {
  it('serves the default seed', async () => {
    const api = new StubApi();
    const s = await api.getSession();
    expect(s.user.name).toBe('Ada Admin');
    expect(s.org.name).toBe('Demo Org');
    expect(s.tenants.map((x) => x.slug)).toEqual(['demo', 'sandbox']);
    const boards = await api.listBoards('demo');
    expect(boards.map((b) => b.title)).toEqual([
      'Service overview',
      'Checkout latency',
      'Edge gateway, eu-west-1: p99 latency by pod and region after the last deploy',
    ]);
    expect(boards[2]?.uid).toBe('b-3');
  });

  it('rejects unknown tenants and aborted requests', async () => {
    const api = new StubApi();
    expect(await kindOf(api.listBoards('x'))).toBe('notFound');
    const c = new AbortController();
    c.abort();
    expect(await kindOf(api.listBoards('demo', c.signal))).toBe('AbortError');
  });

  it('keeps starred boards per tenant in localStorage', async () => {
    const api = new StubApi();
    expect(await api.listStarred('demo')).toEqual(['b-1']);
    expect(await api.setStarred('demo', 'b-2', true)).toEqual(['b-1', 'b-2']);
    expect(localStorage.getItem('pulsus-dash.stub.starred.demo')).toBe('["b-1","b-2"]');
  });

  it('fails sign-out as many times as the test hook says', async () => {
    const api = new StubApi();
    localStorage.setItem('pulsus-dash.stub.failSignOut', '1');
    expect(await kindOf(api.signOut())).toBe('network');
    expect(localStorage.getItem('pulsus-dash.stub.failSignOut')).toBe('0');
    expect(await kindOf(api.signOut())).toBe('resolved');
  });
});
