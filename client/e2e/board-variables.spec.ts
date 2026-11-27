/**
 * `e2e:board-variables` (#289 §5; SRF-017, T07-013): a board with a query variable `node`
 * (multi, All as `.+`) against the PulsusDB fake through the http-mode BFF. Without a `var-` the
 * board runs every panel with All and no "Set a value"; a pick in the picker adds `var-node` and
 * redraws only the three `$node` panels with the picked value; Back returns to All. The window is
 * the one of the `variables-*` transcripts.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { BOARDS_API, deleteBoard, panelSpec } from './boardApi.ts';
import { fakeRequests } from './fake.ts';

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-01T01:00:00.000Z';
const NODE_PANELS = ['Uptime', 'Queries', 'Memory'];

const boardUrl = (uid: string): string =>
  `/t/demo/board/${uid}?from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}&refresh=off`;

const panel = (page: Page, title: string): Locator =>
  page
    .locator('[data-panel]')
    .filter({ has: page.getByRole('heading', { level: 3, name: title, exact: true }) });

const nodeQuery = (metric: string, regex: string): string =>
  `sum by (instance) (vars_${metric}{instance=~"${regex}"})`;

test.describe('e2e:board-variables (fake)', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF, viewport: { width: 1440, height: 900 } });

  let uid: string | null = null;
  test.afterEach(async ({ request }) => {
    await deleteBoard(request, uid);
    uid = null;
  });

  test('e2e:board-variables All, a pick and Back', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const created = await request.post(BOARDS_API, {
      data: {
        spec: {
          title: `V1 ${info.project.name} ${crypto.randomUUID()}`,
          variables: [
            {
              name: 'node',
              label: 'Node',
              kind: 'query',
              query: { lang: 'promql', text: 'label_values(vars_uptime, instance)' },
              multi: true,
              includeAll: true,
              allValue: '.+',
              default: ['$__all'],
              sort: 'alphaAsc',
              refresh: 'timeChange',
            },
          ],
          panels: [
            panelSpec({
              id: 'p-1',
              title: 'Uptime',
              text: nodeQuery('uptime', '$node'),
              grid: [0, 0, 6, 6],
              vis: { kind: 'line' },
            }),
            panelSpec({
              id: 'p-2',
              title: 'Queries',
              text: nodeQuery('queries', '$node'),
              grid: [6, 0, 6, 6],
              vis: { kind: 'line' },
            }),
            panelSpec({
              id: 'p-3',
              title: 'Memory',
              text: nodeQuery('memory', '$node'),
              grid: [0, 6, 6, 6],
              vis: { kind: 'line' },
            }),
            panelSpec({
              id: 'p-4',
              title: 'Targets',
              text: 'sum(vars_targets)',
              grid: [6, 6, 6, 6],
              vis: { kind: 'line' },
            }),
            panelSpec({
              id: 'p-5',
              title: 'Up',
              text: 'sum(vars_up)',
              grid: [0, 12, 6, 6],
              vis: { kind: 'line' },
            }),
          ],
          sections: [],
        },
      },
    });
    expect(created.status()).toBe(201);
    uid = ((await created.json()) as { uid: string }).uid;

    await page.goto(boardUrl(uid));
    const chip = page.getByRole('button', { name: 'Variable Node: All' });
    await expect(chip).toBeVisible();
    for (const title of [...NODE_PANELS, 'Targets', 'Up']) {
      await expect(panel(page, title).locator('[data-frame-ready="true"]')).toHaveCount(1);
    }
    await expect(page.getByText(/Set a value/)).toHaveCount(0);
    for (const m of ['uptime', 'queries', 'memory']) {
      expect(await fakeRequests(request, { query: nodeQuery(m, '.+') })).not.toHaveLength(0);
    }

    // A pick: the multi-select list toggles n1 (clearing All), then Apply. The fake keeps every
    // request since it started, so the n1 queries are counted before.
    const n1 = async (m: string) =>
      (await fakeRequests(request, { query: nodeQuery(m, '(?-i:(?:n1))') })).length;
    const before = await Promise.all(['uptime', 'queries', 'memory'].map(n1));
    await chip.click();
    const dialog = page.getByRole('dialog', { name: 'Variable Node' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('option', { name: 'n1', exact: true }).click();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(page).toHaveURL(/[?&]var-node=n1(&|$)/);
    await expect(page.getByRole('button', { name: 'Variable Node: n1' })).toBeVisible();
    for (const [i, m] of ['uptime', 'queries', 'memory'].entries()) {
      await expect.poll(() => n1(m)).toBe((before[i] ?? 0) + 1);
    }
    for (const title of NODE_PANELS) {
      await expect(panel(page, title).locator('[data-frame-ready="true"]')).toHaveCount(1);
    }

    await page.goBack();
    await expect(page.getByRole('button', { name: 'Variable Node: All' })).toBeVisible();
    await expect(page).not.toHaveURL(/var-node=/);
  });
});
