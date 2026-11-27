/**
 * Boards through the boards API for the e2e specs (moved from `board-promql.spec.ts`, plan #64 Part
 * B B.3): create a board of panels, delete it, and the panel spec of an input.
 */
import { expect, type APIRequestContext } from '@playwright/test';

export const BOARDS_API = '/api/dash/v1/boards';

export interface PanelInput {
  id: string;
  title: string;
  text: string;
  grid: [number, number, number, number];
  /** The panel's `vis` (its kind, and `options` such as a bar chart's); absent = `{ kind: 'auto' }`. */
  vis?: { kind: string; options?: Record<string, unknown> } & Record<string, unknown>;
  /** The query language; absent = `promql`. */
  lang?: 'promql' | 'logql';
}

export const panelSpec = (p: PanelInput) => ({
  id: p.id,
  title: p.title,
  grid: { x: p.grid[0], y: p.grid[1], w: p.grid[2], h: p.grid[3] },
  query: { lang: p.lang ?? 'promql', text: p.text },
  vis: p.vis ?? { kind: 'auto' },
});

/** Creates a board through the boards API (201) and returns its uid. */
export async function createBoard(
  request: APIRequestContext,
  title: string,
  panels: readonly PanelInput[],
): Promise<string> {
  const created = await request.post(BOARDS_API, {
    data: { spec: { title, panels: panels.map(panelSpec), sections: [] } },
  });
  expect(created.status()).toBe(201);
  return ((await created.json()) as { uid: string }).uid;
}

export async function deleteBoard(request: APIRequestContext, uid: string | null): Promise<void> {
  if (uid === null) return;
  const head = await request.get(`${BOARDS_API}/${uid}`);
  if (head.status() !== 200) return;
  const { etag } = (await head.json()) as { etag: string };
  await request.delete(`${BOARDS_API}/${uid}`, { headers: { 'If-Match': `"${etag}"` } });
}
