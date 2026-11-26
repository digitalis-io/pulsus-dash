/**
 * `e2e:canvas2d-pin` (plan #256 §4.3, §5): the main suite runs on host browsers with uncontrolled
 * GPUs, so its builds pin Canvas 2D (`VITE_ENGINE=canvas2d`: `make e2e-build`, the dev server and
 * the `E2E_SERVER=preview` server). This fails if the pin is lost: every gallery frame must be on
 * Canvas 2D and no engine file may be requested. The engine suite proves the default.
 */
import { expect, test } from '@playwright/test';
import { GALLERY_IDS, GALLERY_URL, open } from './helpers.ts';
import { engineRequests, engines, framesReady } from './engine.ts';

test('e2e:canvas2d-pin: the main suite draws on Canvas 2D and never loads the engine', async ({
  page,
}) => {
  const requests = engineRequests(page);
  await open(page, GALLERY_URL);
  await framesReady(page);
  expect(await engines(page)).toEqual(
    Object.fromEntries(GALLERY_IDS.map((id) => [id, 'canvas2d'])),
  );
  expect(requests).toEqual([]);
});
