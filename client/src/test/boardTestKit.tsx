/** Shared setup of the board page tests: a fake chart engine, ResizeObserver and panel lookups. */
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import createClient from 'openapi-fetch';
import type { paths } from '../api/gen/schema';
import { HttpApi } from '../api/HttpApi';
import { defaultSeed } from '../api/stubData';
import type { Board, BoardSpec, PanelSpec } from '../api/types';
import { ChartEngineContext } from '../engine/index';
import { fakeEngine, type FakeEngine } from './fakeEngine';

export function EngineWrapper({ children }: { children: ReactNode }) {
  return <ChartEngineContext.Provider value={fakeEngine()}>{children}</ChartEngineContext.Provider>;
}

/** A wrapper that provides `engine`, so a test can read its frames. */
export function engineWrapper(engine: FakeEngine) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <ChartEngineContext.Provider value={engine}>{children}</ChartEngineContext.Provider>;
  };
}

/**
 * The panel element (`data-panel`) whose `h3` is `title`. Hidden content counts: the board stays
 * mounted, `aria-hidden`, behind the panel editor dialog (#90).
 */
export function panelOf(title: string): HTMLElement {
  const h = screen.getByRole('heading', { level: 3, name: title, hidden: true });
  const p = h.closest<HTMLElement>('[data-panel]');
  if (p === null) throw new Error(`no panel for ${title}`);
  return p;
}

export function gridOf(title: string): string | null {
  return panelOf(title).getAttribute('data-grid');
}

/** The titles of the board's panels, behind an open dialog too (#90). */
export function panelTitles(): string[] {
  return screen.queryAllByRole('heading', { level: 3, hidden: true }).map((h) => h.textContent);
}

export function grid(
  i: number,
  [x, y, w, h]: readonly number[],
  title = `p-${String(i)}`,
): PanelSpec {
  return {
    id: `p-${String(i)}`,
    title,
    grid: { x: x ?? 0, y: y ?? 0, w: w ?? 1, h: h ?? 1 },
    query: { lang: 'promql', text: 'up' },
    vis: { kind: 'logs' },
  };
}

export function stubBoard(uid: string, spec: BoardSpec) {
  return { uid, title: spec.title, updatedAt: '2026-11-19T12:00:00.000Z', spec };
}

export const BOOTSTRAP = {
  principal: { id: 'local', name: 'Local user', email: '', role: 'admin' },
  org: { slug: 'default', name: 'Default organisation' },
  tenants: [{ slug: 'demo', name: 'demo', datasource: { state: 'not_checked' } }],
  default_tenant: 'demo',
  server: { version: '0.1.0-dev', commit: 'abc' },
  can_sign_out: false,
};

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The wire form of a seeded board, as the BFF serves it. */
export function wireBoard(uid: string, etag = '1') {
  const b = defaultSeed.boards.find((x) => x.uid === uid);
  if (b === undefined) throw new Error(`no seed board ${uid}`);
  return {
    uid,
    title: b.title,
    version: Number(etag),
    updated_at: b.updatedAt,
    updated_by: { kind: 'local', name: 'Local user' },
    etag,
    schema_version: 1,
    spec: b.spec,
  };
}

/**
 * An `HttpApi` over a fake fetch that serves the bootstrap, the seeded boards and `put` for
 * `PUT /api/dash/v1/boards/{uid}`.
 */
export function httpApi(put?: (req: Request) => Promise<Response>): HttpApi {
  const client = createClient<paths>({
    baseUrl: 'http://localhost',
    fetch: (req: Request) => {
      const path = new URL(req.url).pathname;
      if (path === '/api/dash/v1/bootstrap') return Promise.resolve(json(200, BOOTSTRAP));
      if (path === '/api/dash/v1/boards' && req.method === 'GET') {
        return Promise.resolve(
          json(200, {
            items: defaultSeed.boards.map((b) => {
              const w = wireBoard(b.uid);
              return {
                uid: w.uid,
                title: w.title,
                version: w.version,
                updated_at: w.updated_at,
                updated_by: w.updated_by,
              };
            }),
            truncated: false,
          }),
        );
      }
      const m = /^\/api\/dash\/v1\/boards\/([^/]+)$/.exec(path);
      if (m !== null && req.method === 'GET') {
        const uid = m[1] ?? '';
        if (!defaultSeed.boards.some((b) => b.uid === uid)) {
          return Promise.resolve(json(404, { error: { code: 'not_found', message: 'not found' } }));
        }
        return Promise.resolve(json(200, wireBoard(uid)));
      }
      if (m !== null && req.method === 'PUT' && put !== undefined) return put(req);
      return Promise.resolve(json(500, { error: { code: 'internal', message: 'unexpected' } }));
    },
  });
  return new HttpApi(client);
}

/** A promise with its resolve function. */
export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export type { Board };
