// unit:log-stream (plan #66 Part B §5.3): LogStream in jsdom.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/types';
import { LOG_LEVELS } from '../data/logFrame';
import { createSynthLogApi } from '../dev/logSynth';
import { TimeZoneContext } from '../state/timeZone';
import { installLayout } from '../test/fakeLayout';
import { logFrame, pageRows, seriesResult, streamsResult } from '../test/logFrames';
import { scriptedLogsApi } from '../test/scriptedLogsApi';
import { LogPager, type LogPagerInput } from './logPager';
import { LogStream, type LogStreamHandle, type LogStreamProps } from './LogStream';

const input: LogPagerInput = {
  tenant: 'demo',
  query: '{app="x"}',
  fromMs: 1767225600000,
  toMs: 1767229200000,
  widthPx: 800,
  direction: 'backward',
};

let restore: () => void = () => undefined;
beforeEach(() => {
  restore = installLayout({ width: 800, height: 400 });
});
afterEach(() => {
  restore();
});

type Props = Partial<Omit<LogStreamProps, 'pager'>> & { pager: LogPager };

function stream(p: Props) {
  const props: LogStreamProps = {
    label: 'Log lines',
    wrap: false,
    onWrapChange: vi.fn(),
    onDirectionChange: vi.fn(),
    onRerun: vi.fn(),
    ...p,
  };
  return {
    props,
    ui: (
      <TimeZoneContext.Provider value="UTC">
        <LogStream {...props} />
      </TimeZoneContext.Provider>
    ),
  };
}

function mount(p: Props) {
  const s = stream(p);
  const r = render(s.ui);
  return {
    ...r,
    props: s.props,
    rerenderWith: (q: Partial<Props>) => {
      r.rerender(stream({ ...s.props, ...q }).ui);
    },
  };
}

const scroller = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('[data-log-scroller]');
  if (el === null) throw new Error('no scroller');
  return el;
};
const items = (): HTMLElement[] => within(screen.getByRole('list')).queryAllByRole('listitem');
const rowOf = (posinset: number): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[aria-posinset="${String(posinset)}"]`);

/** A synth pager with `pages` pages of 1 000 loaded (latency 0). */
async function synthPager(pages: number, total = 20_000) {
  const synth = createSynthLogApi({ total });
  const pager = new LogPager(synth, input);
  await pager.start();
  for (let i = 1; i < pages; i += 1) await pager.loadTail();
  return { synth, pager };
}

async function scrollTo(top: number) {
  await act(async () => {
    scroller().scrollTop = top;
    fireEvent.scroll(scroller());
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('unit:log-stream', () => {
  it('L1 gutter, timestamp and line', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    const { container } = mount({ pager });
    await act(() =>
      api.resolve(
        0,
        streamsResult(
          logFrame([{ ts: 1767229100000000300n, level: 'error', line: '<script>x</script>' }]),
          null,
        ),
      ),
    );
    const row = rowOf(1);
    if (row === null) throw new Error('no row');
    const glyph = within(row).getByText('ERR');
    expect(glyph).toHaveAttribute('aria-hidden', 'true');
    expect(within(row).getByText('Error')).toBeInTheDocument();
    expect(within(row).getByText('2026-01-01 00:58:20.000')).toBeInTheDocument();
    expect(row.querySelector('[data-log-line]')?.textContent).toBe('<script>x</script>');
    expect(container.querySelector('script')).toBeNull();
  });

  it('L2 one row per level: glyph, data-level and name', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    mount({ pager });
    const levels = [...LOG_LEVELS].reverse();
    await act(() =>
      api.resolve(
        0,
        streamsResult(
          logFrame(
            levels.map((level, i) => ({
              ts: 1767229100000000000n - BigInt(i),
              level,
              line: level,
            })),
          ),
          null,
        ),
      ),
    );
    const rows = levels.map((_, i) => rowOf(i + 1));
    const glyphs = rows.map((r) => r?.querySelector('[data-log-glyph]')?.textContent);
    expect(glyphs).toEqual(['CRT', 'ERR', 'WRN', 'INF', 'DBG', 'TRC', 'UNK']);
    expect(new Set(glyphs).size).toBe(7);
    expect(rows.map((r) => r?.dataset['level'])).toEqual(levels);
    const names = ['Critical', 'Error', 'Warning', 'Info', 'Debug', 'Trace', 'Unknown level'];
    rows.forEach((r, i) => {
      expect(r?.textContent).toContain(names[i]);
    });
  });

  it('L3 wrap control', async () => {
    const { pager } = await synthPager(1);
    const { props, rerenderWith } = mount({ pager });
    const root = document.querySelector('[data-wrap]');
    expect(root).toHaveAttribute('data-wrap', 'false');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wrap lines' }));
    expect(props.onWrapChange).toHaveBeenCalledTimes(1);
    expect(props.onWrapChange).toHaveBeenCalledWith(true);
    rerenderWith({ wrap: true });
    expect(document.querySelector('[data-wrap]')).toHaveAttribute('data-wrap', 'true');
  });

  it('L4 order control', async () => {
    const { pager } = await synthPager(1);
    const { props } = mount({ pager });
    const group = screen.getByRole('radiogroup', { name: 'Order' });
    expect(within(group).getByRole('radio', { name: 'Newest first' })).toBeChecked();
    fireEvent.click(within(group).getByRole('radio', { name: 'Oldest first' }));
    expect(props.onDirectionChange).toHaveBeenCalledTimes(1);
    expect(props.onDirectionChange).toHaveBeenCalledWith('forward');
  });

  it('L5 virtualised: at most 42 rows of 10 000 mounted', async () => {
    const { pager } = await synthPager(10);
    mount({ pager });
    await waitFor(() => {
      expect(rowOf(1)).not.toBeNull();
    });
    expect(items().length).toBeLessThanOrEqual(42);
    expect(items()[0]).toHaveAttribute('aria-posinset', '1');
  });

  it('L6 prefetch near the end', async () => {
    const { synth, pager } = await synthPager(10);
    mount({ pager });
    const before = synth.calls.length;
    await scrollTo(10_000 * 20);
    await waitFor(() => {
      expect(synth.calls.length).toBeGreaterThan(before);
    });
    expect(synth.calls[before]?.cursor).toBe(pager.buffer.cursorOf(10));
  });

  it('L7 tail sentinels', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    mount({ pager });
    await act(() => api.resolve(0, streamsResult(logFrame(pageRows(0, 3)), 'c1')));
    expect(await screen.findByText('Loading more lines…')).toBeInTheDocument();
    expect(api.calls[1]?.req.cursor).toBe('c1');
    await act(() => api.reject(1, new ApiError('timeout', 'timed out')));
    expect(await screen.findByText('Could not load log lines.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(api.calls).toHaveLength(3);
    expect(api.calls[2]?.req.cursor).toBe('c1');
    await act(() => api.resolve(2, streamsResult(logFrame(pageRows(1, 2)), null)));
    expect(await screen.findByText('End of results')).toBeInTheDocument();
  });

  it('L7 tail drift', async () => {
    // Page 1 is evicted at the tail by the head re-fetch, then answers other lines.
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input, { entries: 2 });
    void pager.start();
    await api.resolve(0, streamsResult(logFrame(pageRows(0, 2)), 'k1'));
    void pager.loadTail();
    await api.resolve(1, streamsResult(logFrame(pageRows(1, 2)), 'k2'));
    void pager.loadHead();
    await api.resolve(2, streamsResult(logFrame(pageRows(0, 2)), 'k1'));
    expect(pager.buffer.tailPage).toBe(1);
    void pager.loadTail();
    await api.resolve(3, streamsResult(logFrame(pageRows(1, 2, (i) => `x${String(i)}`)), 'k2'));
    expect(pager.getState().tail.status).toBe('drift');
    const { props } = mount({ pager });
    expect(screen.getByText('These lines changed since they were loaded.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    expect(props.onRerun).toHaveBeenCalledTimes(1);
  });

  it('L8 head re-fetch', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input, { entries: 1000 });
    const ref = createRef<LogStreamHandle>();
    void pager.start();
    mount({ pager, ref });
    const page = (k: number) => streamsResult(logFrame(pageRows(k, 1000)), `c${String(k + 1)}`);
    await act(() => api.resolve(0, page(0)));
    await waitFor(() => {
      expect(api.calls).toHaveLength(2);
    });
    await act(() => api.resolve(1, page(1)));
    await waitFor(() => {
      expect(api.calls).toHaveLength(3);
    });
    // To the bottom of page 1, then page 2 lands: page 0 is evicted.
    await scrollTo(2000 * 20 - 400);
    await act(() => api.resolve(2, page(2)));
    await waitFor(() => {
      expect(pager.buffer.firstOrd).toBe(1000);
    });
    const noCursor = () => api.calls.filter((c) => c.req.cursor === undefined).length;
    expect(noCursor()).toBe(1);
    act(() => {
      ref.current?.scrollToOrd(1000);
    });
    await scrollTo(scroller().scrollTop);
    await waitFor(() => {
      expect(noCursor()).toBe(2);
    });
    expect(await screen.findByText('Loading earlier lines…')).toBeInTheDocument();
    const head = api.calls.findLastIndex((c) => c.req.cursor === undefined);
    await act(() => api.reject(head, new ApiError('timeout', 'timed out')));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(noCursor()).toBe(3);
  });

  it('L9 list name, aria-posinset and aria-setsize', async () => {
    const api = scriptedLogsApi();
    const pager = new LogPager(api, input);
    void pager.start();
    mount({ pager });
    await act(() => api.resolve(0, streamsResult(logFrame(pageRows(0, 3)), 'c1')));
    expect(screen.getByRole('list', { name: 'Log lines' })).toBeInTheDocument();
    expect(rowOf(3)).toHaveAttribute('aria-setsize', '-1');
    await waitFor(() => {
      expect(api.calls).toHaveLength(2);
    });
    await act(() => api.resolve(1, streamsResult(logFrame([]), null)));
    expect(rowOf(3)).toHaveAttribute('aria-setsize', '3');
  });

  it('L10 phases', async () => {
    const pending = scriptedLogsApi();
    const p1 = new LogPager(pending, input);
    void p1.start();
    const a = mount({ pager: p1 });
    expect(screen.getByText('Loading log lines…')).toBeInTheDocument();
    await act(() => pending.reject(0, new ApiError('queryInvalid', 'bad')));
    expect(screen.getByText('Could not load log lines.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    a.unmount();

    const empty = scriptedLogsApi();
    const p2 = new LogPager(empty, input);
    void p2.start();
    const b = mount({ pager: p2 });
    await act(() => empty.resolve(0, streamsResult(logFrame([]), null)));
    expect(screen.getByText('No log lines in this time range')).toBeInTheDocument();
    b.unmount();

    const metric = scriptedLogsApi();
    const p3 = new LogPager(metric, input);
    void p3.start();
    const c = mount({ pager: p3 });
    await act(() => metric.resolve(0, seriesResult()));
    expect(c.container).toBeEmptyDOMElement();
  });

  it('L11 handle', async () => {
    const { pager } = await synthPager(10);
    const ref = createRef<LogStreamHandle>();
    mount({ pager, ref });
    act(() => {
      ref.current?.scrollToOrd(5000);
    });
    await scrollTo(scroller().scrollTop);
    await waitFor(() => {
      expect(rowOf(5001)).not.toBeNull();
    });
  });
});
