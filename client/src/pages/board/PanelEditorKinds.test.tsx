/**
 * The barchart boundary in the panel editor (#173 Part 2 §5 boundary): the bar chart is offered
 * only as the disabled option of a panel that stores it.
 */
import { cleanup, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PanelSpec } from '../../api/types';
import { resetQueryLanguages } from '../../boards/useQueryLanguage';
import { editorOn, openBoard, ready, settled, show } from '../../test/boardPanelKit';
import { panel } from '../../test/boardTestKit';
import { fakeEditorSource } from '../../test/fakeEditor';
import {
  installIntersectionObserver,
  uninstallIntersectionObserver,
} from '../../test/fakeIntersectionObserver';
import { F } from '../../test/fakePromSource';
import { installResizeObserver } from '../../test/fakeResizeObserver';
import { R_A } from '../../test/rangeFixtures';

vi.mock('../../editor/editor', () => import('../../test/fakeEditor'));

beforeEach(() => {
  installResizeObserver();
  installIntersectionObserver();
  resetQueryLanguages();
  fakeEditorSource.data = F;
});

afterEach(() => {
  cleanup();
  uninstallIntersectionObserver();
});

async function options(vis: PanelSpec['vis']): Promise<HTMLElement[]> {
  const t = openBoard([{ ...panel('p-1', 'Requests', 'http_requests_total'), vis }]);
  t.range.mockResolvedValue(R_A);
  await ready('Requests');
  show('Requests');
  if (vis.kind !== 'barchart') await settled(t, 'Requests');
  const d = await editorOn(t, 'Requests');
  await t.user.click(within(d).getByRole('button', { name: /Visualisation$/ }));
  return screen.findAllByRole('option');
}

describe('barchart boundary: editor', () => {
  it('a line panel offers no bar chart', async () => {
    const names = (await options({ kind: 'line' })).map((o) => o.textContent);
    expect(names).not.toContain('Bar chart');
  });

  it('a stored bar chart shows as a disabled option', async () => {
    const opts = await options({ kind: 'barchart' });
    const bar = opts.find((o) => o.textContent === 'Bar chart');
    expect(bar).toBeDefined();
    expect(bar).toHaveAttribute('aria-disabled', 'true');
  });
});
