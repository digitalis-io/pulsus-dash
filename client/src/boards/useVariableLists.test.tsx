/** unit:variable-lists (SRF-017, plan #289 §4.3): the lists in spec order, chained. */
import { act, screen, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { StubApi } from '../api/StubApi';
import type { BoardVariable, VariableValues, VariableValuesRequest } from '../api/types';
import { ApiContext } from '../app/providers';
import { renderRouted } from '../test/routedHarness';
import { useVariableLists, type VariableLists } from './useVariableLists';

const URL1 = '/?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z&refresh=off';
const URL2 = '/?from=2026-11-19T13:00:00.000Z&to=2026-11-19T14:00:00.000Z&refresh=off';

function q(
  name: string,
  text: string,
  refresh: 'load' | 'timeChange' = 'timeChange',
): BoardVariable {
  return {
    name,
    label: name.toUpperCase(),
    kind: 'query',
    query: { lang: 'promql', text },
    multi: true,
    includeAll: false,
    sort: 'none',
    refresh,
  };
}
const A = q('a', 'label_values(a)');
const B = q('b', 'label_values(x{a=~"$a"}, b)');
const C = q('c', 'label_values(x{b=~"$b"}, c)');

interface Call {
  readonly req: VariableValuesRequest;
  readonly signal: AbortSignal | undefined;
  resolve(values: readonly string[]): void;
  reject(e: unknown): void;
}

function mount(
  defs: readonly BoardVariable[],
  address: ReadonlyMap<string, readonly string[]> = new Map(),
  legacy: readonly string[] = [],
) {
  const api = new StubApi();
  const calls: Call[] = [];
  vi.spyOn(api, 'variableValues').mockImplementation(
    (_tenant, req, signal) =>
      new Promise<VariableValues>((resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
        calls.push({
          req,
          signal,
          resolve: (values) => {
            resolve({ planned: { label: '', match: null }, values, truncated: false });
          },
          reject,
        });
      }),
  );
  const out: {
    lists: VariableLists | null;
    setAddress: (a: ReadonlyMap<string, readonly string[]>) => void;
    setTenant: (t: string) => void;
    unmount: () => void;
  } = {
    lists: null,
    setAddress: () => undefined,
    setTenant: () => undefined,
    unmount: () => undefined,
  };
  function Host() {
    const [addr, setAddr] = useState(address);
    const [tenant, setTenant] = useState('demo');
    out.setAddress = setAddr;
    out.setTenant = setTenant;
    const l = useVariableLists({
      tenant,
      uid: 'b-1',
      defs,
      address: addr,
      legacy,
      timeReady: true,
    });
    out.lists = l;
    return <p>{[...l.states].map(([n, s]) => `${n}:${s.kind}`).join(' ')}</p>;
  }
  function Toggle() {
    const [on, set] = useState(true);
    out.unmount = () => {
      set(false);
    };
    return on ? <Host /> : <p>off</p>;
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const r = renderRouted(
    <ApiContext.Provider value={api}>
      <Toggle />
    </ApiContext.Provider>,
    { url: URL1, queryClient },
  );
  return { ...r, calls, out };
}

const names = (calls: readonly Call[]) =>
  calls.map((c) => /label_values\((?:.*, )?(\w+)\)/.exec(c.req.query)?.[1]);

describe('unit:variable-lists', () => {
  it('fetches B after A is ready, then C', async () => {
    const { calls } = mount([A, B, C]);
    await waitFor(() => {
      expect(names(calls)).toEqual(['a']);
    });
    await act(async () => {
      calls[0]?.resolve(['a1', 'a2']);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(names(calls)).toEqual(['a', 'b']);
    });
    expect(calls[1]?.req.vars).toEqual({ a: { values: ['a1'] } });
    expect(calls[1]?.req.limit).toBe(1000);
    await act(async () => {
      calls[1]?.resolve(['b1']);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(names(calls)).toEqual(['a', 'b', 'c']);
    });
    expect(calls[2]?.req.vars).toEqual({ b: { values: ['b1'] } });
  });

  it('A fails: B and C wait unfetched; Retry fetches A, B, C in order', async () => {
    const { calls, out } = mount([A, B, C]);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await act(async () => {
      calls[0]?.reject(new Error('down'));
      await Promise.resolve();
    });
    await screen.findByText('a:failed b:waiting c:waiting');
    expect(out.lists?.states.get('b')).toEqual({ kind: 'waiting', on: 'a' });
    expect(calls).toHaveLength(1);
    act(() => {
      out.lists?.retry('a');
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await act(async () => {
      calls[1]?.resolve(['a1']);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(names(calls)).toEqual(['a', 'a', 'b']);
    });
    await act(async () => {
      calls[2]?.resolve(['b1']);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(names(calls)).toEqual(['a', 'a', 'b', 'c']);
    });
  });

  it('A empty: B waits', async () => {
    const { calls } = mount([A, B]);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await act(async () => {
      calls[0]?.resolve([]);
      await Promise.resolve();
    });
    await screen.findByText('a:unset b:waiting');
    expect(calls).toHaveLength(1);
  });

  it('a change of A refetches B and C', async () => {
    const { calls, out } = mount([A, B, C]);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    await act(async () => {
      calls[0]?.resolve(['a1', 'a2']);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await act(async () => {
      calls[1]?.resolve(['b1']);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(calls).toHaveLength(3);
    });
    await act(async () => {
      calls[2]?.resolve(['c1']);
      await Promise.resolve();
    });
    act(() => {
      out.setAddress(new Map([['a', ['a2']]]));
    });
    await waitFor(() => {
      expect(names(calls)).toEqual(['a', 'b', 'c', 'b']);
    });
    expect(calls[3]?.req.vars).toEqual({ a: { values: ['a2'] } });
    await act(async () => {
      calls[3]?.resolve(['b2']);
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(names(calls)).toEqual(['a', 'b', 'c', 'b', 'c']);
    });
    expect(calls[4]?.req.vars).toEqual({ b: { values: ['b2'] } });
  });

  it('a window change: load sends nothing, timeChange one request', async () => {
    const load = q('l', 'label_values(l)', 'load');
    const change = q('t', 'label_values(t)', 'timeChange');
    const { calls, router } = mount([load, change]);
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    await act(async () => {
      calls[0]?.resolve(['1']);
      calls[1]?.resolve(['1']);
      await Promise.resolve();
    });
    await act(async () => {
      await router.navigate(URL2);
    });
    await waitFor(() => {
      expect(names(calls)).toEqual(['l', 't', 't']);
    });
    expect(calls[2]?.req.fromMs).toBe(Date.UTC(2026, 10, 19, 13));
    expect(calls[0]?.req.fromMs).toBe(Date.UTC(2026, 10, 19, 12));
  });

  it('a tenant switch aborts the request in flight and asks the new tenant', async () => {
    const { calls, out } = mount([A]);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    act(() => {
      out.setTenant('demo2');
    });
    await waitFor(() => {
      expect(calls[0]?.signal?.aborted).toBe(true);
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
  });

  it('a legacy reference takes its URL value, and a new value refetches (review r1)', async () => {
    const J = q('j', 'label_values(up{job="$job"}, instance)');
    const { calls, out } = mount([J], new Map([['job', ['api']]]), ['job']);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.req.vars).toEqual({ job: 'api' });
    act(() => {
      out.setAddress(new Map([['job', ['web']]]));
    });
    await waitFor(() => {
      expect(calls).toHaveLength(2);
    });
    expect(calls[1]?.req.vars).toEqual({ job: 'web' });
    // Without a value the list waits for it, unfetched.
    act(() => {
      out.setAddress(new Map());
    });
    await waitFor(() => {
      expect(out.lists?.states.get('j')).toEqual({ kind: 'waiting', on: 'job' });
    });
    expect(calls).toHaveLength(2);
  });

  it('the language is part of the key (review r1)', async () => {
    const first = mount([q('l', 'label_values(a)')]);
    await waitFor(() => {
      expect(first.calls).toHaveLength(1);
    });
    const keys = first.queryClient
      .getQueryCache()
      .getAll()
      .map((x) => x.queryKey);
    expect(keys).toContainEqual(
      expect.arrayContaining(['varValues', 'l', 'promql', 'label_values(a)']),
    );
  });

  it('unmount aborts the request in flight', async () => {
    const { calls, out } = mount([A]);
    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    act(() => {
      out.unmount();
    });
    await waitFor(() => {
      expect(calls[0]?.signal?.aborted).toBe(true);
    });
  });
});
