import { act, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ChartEngineContext } from '../engine/index';
import { fakeEngine } from '../test/fakeEngine';
import { installResizeObserver, resizeAll } from '../test/fakeResizeObserver';
import '../test/editorDom';
import { locationOf, renderApp } from '../test/renderApp';
import type { RouteObject } from 'react-router';
import { createRoutes, type RouterDeps } from './router';

async function settled(
  router: ReturnType<typeof renderApp>['router'],
  path: string,
): Promise<void> {
  await waitFor(() => {
    expect(router.state.initialized).toBe(true);
    expect(router.state.navigation.state).toBe('idle');
    expect(router.state.location.pathname).toBe(path);
  });
}

describe('redirects and normalises', () => {
  it.each([
    ['/', '/t/demo/boards?from=now-1h&to=now&refresh=off'],
    ['/t/demo/admin', '/t/demo/admin?from=now-1h&to=now&refresh=off'],
    [
      '/t/demo/boards?from=2026-11-19T12:03:00.000Z&to=2026-11-19T13:03:00.000Z',
      '/t/demo/boards?from=2026-11-19T12%3A03%3A00.000Z&to=2026-11-19T13%3A03%3A00.000Z&refresh=off',
    ],
  ])('%s → %s (REPLACE)', async (url, want) => {
    const { router } = renderApp(url);
    await settled(router, want.split('?')[0] ?? '');
    expect(locationOf(router)).toBe(want);
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('router explore canonical', () => {
  it('the metrics route canonicalises q, vis and rate (REPLACE)', async () => {
    const { router } = renderApp(
      '/t/demo/explore/metrics?vis=pie&q=up&from=now-1h&to=now&refresh=off&q=x',
    );
    await settled(router, '/t/demo/explore/metrics');
    await waitFor(() => {
      expect(locationOf(router)).toBe(
        '/t/demo/explore/metrics?from=now-1h&to=now&refresh=off&q=up',
      );
    });
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('unit:router-logs-params: the logs route canonicalises q, dir and wrap (REPLACE)', async () => {
    const { router } = renderApp('/t/demo/explore/logs?wrap=yes&q=a');
    await settled(router, '/t/demo/explore/logs');
    await waitFor(() => {
      expect(locationOf(router)).toBe('/t/demo/explore/logs?from=now-1h&to=now&refresh=off&q=a');
    });
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('tenant index keeps Context', () => {
  it('redirects to Boards with the canonical search', async () => {
    const { router } = renderApp('/t/demo?from=now-6h');
    await settled(router, '/t/demo/boards');
    expect(locationOf(router)).toBe('/t/demo/boards?from=now-6h&to=now&refresh=off');
    expect(router.state.historyAction).toBe('REPLACE');
  });
});

describe('in-app navigation pushes once', () => {
  it('a sidebar link pushes the canonical target', async () => {
    const { router, user } = renderApp('/t/demo/boards?from=now-6h&to=now&refresh=30s');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await user.click(within(nav).getByRole('link', { name: 'Metrics' }));
    await settled(router, '/t/demo/explore/metrics');
    expect(router.state.historyAction).toBe('PUSH');
    expect(router.state.location.search).toBe('?from=now-6h&to=now&refresh=30s');
  });
});

describe('unknown tenant / path', () => {
  it.each([
    ['/t/other/boards', false],
    ['/t/demo/nope', true],
    ['/nope', false],
  ])('%s shows Page not found (in the shell: %s)', async (url, inShell) => {
    renderApp(url);
    if (inShell) {
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Page not found' }),
      ).toBeInTheDocument();
      expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    } else {
      expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
      expect(screen.queryByRole('navigation')).toBeNull();
    }
  });
});

describe('current nav item', () => {
  it('marks Boards current on a board page, and nothing else', async () => {
    // Board panels measure their bodies (plan #64 §3.4).
    installResizeObserver();
    renderApp('/t/demo/board/b-1');
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    await screen.findByRole('heading', { level: 1, name: 'Service overview' });
    const current = nav.querySelectorAll('[aria-current]');
    expect([...current].map((e) => e.textContent)).toEqual(['Boards']);
    expect(within(nav).getByRole('link', { name: 'Boards' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('gallery route', () => {
  it('renders the twenty gallery charts on stub data', async () => {
    installResizeObserver();
    const engine = fakeEngine();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ChartEngineContext.Provider value={engine}>{children}</ChartEngineContext.Provider>
    );
    renderApp('/t/demo/dev/gallery?from=2026-11-19T12:00:00.000Z&to=2026-11-19T13:00:00.000Z', {
      wrapper,
    });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Chart gallery' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('[data-gallery-id]')).toHaveLength(20);
    });
    // The five bar charts (#173 Part 2) mount their frames once their cells are measured.
    act(() => {
      resizeAll(600, 240);
    });
    expect(screen.getAllByRole('slider')).toHaveLength(10);
    expect(document.querySelectorAll('canvas')).toHaveLength(18);
    expect(engine.frames).toHaveLength(18);
  });
});

// Plan #66 Part A §3.12: the dev-only LogQL editor harness of the two benches.
describe('unit:router-dev-logql', () => {
  it('renders the LogQL editor with the q text', async () => {
    renderApp('/t/demo/dev/logql-editor?q=%7Ba%3D%22b%22%7D');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'LogQL editor bench' }),
    ).toBeInTheDocument();
    const host = await waitFor(() => {
      const el = [...document.querySelectorAll('[data-editor-host] > *')].find(
        (e) => e.shadowRoot !== null,
      );
      if (el?.shadowRoot?.firstElementChild === null || el === undefined)
        throw new Error('no editor');
      return el.shadowRoot?.firstElementChild as HTMLElement;
    });
    const box = within(host).getByRole('textbox', { name: 'LogQL query' });
    expect(box.textContent).toBe('{a="b"}');
  });
});

// Plan #66 Part B §2, B.2: the dev-only log stream harness, in dev and stub builds only.
describe('unit:router-dev-log-stream', () => {
  const ids = (routes: readonly RouteObject[]): string[] =>
    routes.flatMap((r) => [r.id ?? '', ...ids(r.children ?? [])]);

  it('renders the harness in the stub build', async () => {
    renderApp('/t/demo/dev/log-stream');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Log stream bench' }),
    ).toBeInTheDocument();
  });

  it('has no logStreamBench route in the http build', () => {
    const deps: RouterDeps = {
      api: {} as never,
      queryClient: {} as never,
      clock: {} as never,
      timeZone: 'UTC',
    };
    expect(ids(createRoutes(deps))).toContain('logStreamBench');
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_MODE', 'http');
    try {
      const http = ids(createRoutes(deps));
      expect(http).toContain('logs');
      expect(http).not.toContain('logStreamBench');
      expect(http).not.toContain('logqlBench');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

// Plan #198 Part 3b §2: the widget gallery's Text pages (dev and stub builds only).
describe('unit:widget-gallery-route', () => {
  it('widget-text: the three Text bodies', async () => {
    installResizeObserver();
    renderApp('/t/demo/dev/widgets?page=widget-text');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Widget gallery' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelectorAll('[data-widget-gallery] [data-text-body]')).toHaveLength(3);
    });
  });

  it('widget-text-removals: the editor body lists 7 removals', async () => {
    installResizeObserver();
    renderApp('/t/demo/dev/widgets?page=widget-text-removals');
    await waitFor(
      () => {
        const lists = document.querySelectorAll('[data-text-removals]');
        expect(lists).toHaveLength(1);
        expect(lists[0]?.querySelectorAll('li')).toHaveLength(7);
      },
      { timeout: 5_000 },
    );
  });

  // Plan #216 Part 2a §4.6: the Board list pages.
  for (const [page, n] of [
    ['widget-board-list', 2],
    ['widget-board-list-search', 2],
    ['widget-board-list-states', 4],
  ] as const) {
    it(`${page}: ${String(n)} Board list bodies`, async () => {
      installResizeObserver();
      renderApp(`/t/demo/dev/widgets?page=${page}`);
      await waitFor(
        () => {
          expect(document.querySelectorAll('[data-widget-gallery] [data-board-list]')).toHaveLength(
            n,
          );
        },
        { timeout: 5_000 },
      );
    });
  }

  it('has no widgetGallery route in the http build', () => {
    const deps: RouterDeps = {
      api: {} as never,
      queryClient: {} as never,
      clock: {} as never,
      timeZone: 'UTC',
    };
    const ids = (routes: readonly RouteObject[]): string[] =>
      routes.flatMap((r) => [r.id ?? '', ...ids(r.children ?? [])]);
    expect(ids(createRoutes(deps))).toContain('widgetGallery');
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_API_MODE', 'http');
    try {
      expect(ids(createRoutes(deps))).not.toContain('widgetGallery');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
