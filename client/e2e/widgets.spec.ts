/**
 * The Text widget in real browsers (plan #198 Part 3b §4.1, §4.2, §5; T24 §10), on boards created
 * through the boards API of the http-mode BFF, in Chromium, Firefox and WebKit:
 *
 * - `e2e:widget-text`: the T24 §10 input, a variable change, no query, the named region, and a
 *   Text added through Add widget that survives Save and a reload.
 * - `e2e:widget-text-xss` (a): the T24 row input under the production CSP, watched (`loadWatch.ts`),
 *   then its removal lines in the editor.
 * - `e2e:widget-text-xss` (b): the whole XSS corpus (`fixtures/xss-e2e-cases.json`), one case per
 *   fresh context on its own one-panel board, against the committed per-browser load baseline.
 * - `e2e:widget-text-xss` (c): the canaries c1–c12, each proving one class of miss.
 * - `e2e:widget-a11y` (Text): axe, the T24-017 tab order and the editor's preview.
 */
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { parseFragment, type DefaultTreeAdapterTypes } from 'parse5';
import { CSP } from '../config/headers.ts';
import { corpusInput, generate } from '../scripts/gen-xss-e2e-cases.ts';
import { t } from '../src/i18n/t.ts';
import markdownStyles from '../src/security/sanitise/markdown.module.css';
import {
  checkInvariants,
  type TElement,
  type TNode,
} from '../src/security/sanitise/testInvariants.ts';
import type { CorpusCase } from '../src/security/sanitise/xssCorpus.ts';
import { HTTP_BFF, NEEDS_BFF, PREVIEW } from './bff.ts';
import { deleteBoard } from './boardApi.ts';
import { fakeRequests, sec } from './fake.ts';
import {
  axeSerious,
  BOARD_TIME,
  createTextBoard,
  postTextBoard,
  type TextPanelInput,
} from './helpers.ts';
import {
  closeWatched,
  compareBaseline,
  openWatched,
  readBaseline,
  writeBaseline,
  type Baseline,
  type LoadFinding,
  type LoadWatch,
  type Watched,
} from './loadWatch.ts';
import { compareCases, readCommittedCases, type E2eCase } from './xssCases.ts';

declare global {
  interface Window {
    __xss?: unknown;
  }
}

const UPDATE_BASELINE = process.env['BASELINE_UPDATE'] === '1';
/** Corpus cases checked at once, each in its own context. */
const CONCURRENCY = 3;
const FORBIDDEN = 'iframe, script, object, embed, frame, base, link, meta, form';
/** Every case's board: one Text panel at {0, 0, 12, 8}. */
const PANEL: TextPanelInput = { id: 'p-1', title: 'Text', content: '', grid: [0, 0, 12, 8] };
/**
 * The twin's content: inert text and one kept link, so the Markdown chunk and the new-tab glyph's
 * icon (a kit `Icon` mask image) are in the baseline as every rendered link loads them.
 */
const TWIN_CONTENT = 'x [x](/b)';

const unique = (what: string, project: string): string =>
  `E2E ${what} ${project} ${crypto.randomUUID()}`;

function boardUrl(uid: string, vars: readonly (readonly [string, string])[]): string {
  const q = new URLSearchParams(vars.map(([k, v]) => [`var-${k}`, v]));
  return `/t/demo/board/${uid}?${BOARD_TIME}&${q.toString()}`;
}

/** Wraps the dialog functions so a payload that reaches one sets `window.__xss` too. */
async function trapDialogs(target: { addInitScript: Page['addInitScript'] }): Promise<void> {
  await target.addInitScript(() => {
    for (const name of ['alert', 'confirm', 'prompt'] as const) {
      Object.defineProperty(window, name, {
        value: () => {
          window.__xss = name;
          return null;
        },
      });
    }
  });
}

/** A parse5 fragment as a `TNode` tree (the fuzz's adapter). */
function fromParse5(f: DefaultTreeAdapterTypes.DocumentFragment): TElement {
  const conv = (n: DefaultTreeAdapterTypes.ChildNode): TNode | null => {
    if (n.nodeName === '#text')
      return { kind: 'text', value: (n as DefaultTreeAdapterTypes.TextNode).value };
    if (!('tagName' in n)) return null;
    const attrs = new Map(n.attrs.map((a) => [a.name, a.value] as const));
    return { kind: 'element', tag: n.tagName, attrs, children: kids(n.childNodes) };
  };
  const kids = (ns: readonly DefaultTreeAdapterTypes.ChildNode[]): TNode[] =>
    ns.map(conv).filter((x): x is TNode => x !== null);
  return { kind: 'element', tag: '#root', attrs: new Map(), children: kids(f.childNodes) };
}

/**
 * The Markdown module's production class names, from the loaded Markdown chunk's stylesheet, into
 * the module object the test code sees (Playwright loads CSS modules as `{}`), so
 * `checkInvariants` knows the flat span and the hidden text.
 */
async function learnMarkdownClasses(page: Page): Promise<void> {
  const classes = await page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.href?.includes('/assets/TextMarkdown-') !== true) continue;
      for (const rule of Array.from(sheet.cssRules)) {
        const m = /^\.(_([A-Za-z]+)_[a-z0-9]+_\d+)$/.exec((rule as CSSStyleRule).selectorText);
        if (m?.[1] !== undefined && m[2] !== undefined) out[m[2]] = m[1];
      }
    }
    return out;
  });
  expect(Object.keys(classes).sort(), 'the Markdown chunk stylesheet').toEqual(['flat', 'srOnly']);
  Object.assign(markdownStyles, classes);
}

/** The case checks of §4.1, as failure lines (empty when the case passes). */
async function checkCase(page: Page, images: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  // Read back only, to check what the renderer wrote.
  const html = await page.locator('[data-text-content]').evaluate((e) => e.innerHTML);
  out.push(...checkInvariants(fromParse5(parseFragment(html)), 'board'));
  const imgs = await page.locator('[data-text-content] img').evaluateAll((els) =>
    els.map((e) => {
      const u = new URL(e.getAttribute('src') ?? '', location.origin);
      return u.pathname + u.search;
    }),
  );
  const got = [...new Set(imgs)].sort();
  const want = [...new Set(images)].sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    out.push(`images ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`);
  }
  const forbidden = await page.locator('[data-panel]').evaluate((p, sel) => {
    return Array.from(p.querySelectorAll(sel)).map((e) => e.tagName.toLowerCase());
  }, FORBIDDEN);
  if (forbidden.length > 0) out.push(`forbidden elements ${forbidden.join(', ')}`);
  const xss = await page.evaluate(() => window.__xss);
  if (xss !== undefined) out.push(`window.__xss = ${JSON.stringify(xss)}`);
  return out;
}

/** The Trusted Types check: an HTML sink write throws, and its violation is the only one. */
async function trustedTypesCanary(page: Page, watch: LoadWatch): Promise<string[]> {
  const out: string[] = [];
  const kind = await page.evaluate(
    () => typeof (globalThis as { trustedTypes?: unknown }).trustedTypes,
  );
  if (kind !== 'object') return [`trustedTypes is ${kind}`];
  const sink = { threw: 'not run' };
  const consumed = await watch.consumeTrustedTypesCanary(async () => {
    sink.threw = await page.evaluate(() => {
      try {
        // The canary: the production policy must refuse a plain string in an HTML sink.
        // eslint-disable-next-line no-restricted-syntax, security/no-html-sink
        document.createElement('div').innerHTML = '<b>x</b>';
        return 'no error';
      } catch (e) {
        return e instanceof TypeError ? 'TypeError' : String(e);
      }
    });
  });
  if (sink.threw !== 'TypeError') out.push(`the sink write gave ${sink.threw}`);
  if (!consumed) out.push('the Trusted Types canary was not consumed');
  return out;
}

/** A finding as one comparable line (console texts differ by engine: their kind is enough). */
function line(f: LoadFinding): string {
  switch (f.kind) {
    case 'request':
      return `request ${f.key}`;
    case 'imageMissing':
      return `imageMissing ${f.path}`;
    case 'csp':
      return `csp ${f.directive}`;
    case 'sw':
      return `sw ${f.url}`;
    case 'console':
      return 'console';
    case 'pageerror':
      return `pageerror ${f.message}`;
    case 'setup':
      return `setup ${f.message}`;
  }
}

const lines = (w: LoadWatch): string[] => w.findings().map(line).sort();

/** Opens `url` in a watched page and waits for the Text content; the navigation's CSP header. */
async function openCase(w: Watched, url: string): Promise<string | null> {
  try {
    const resp = await w.page.goto(url);
    await w.page.locator('html[data-shell-ready="true"]').waitFor({ timeout: 20_000 });
    // Attached, not visible: a case whose every block is removed renders an empty content.
    await w.page.locator('[data-text-content]').waitFor({ state: 'attached', timeout: 20_000 });
    return resp?.headers()['content-security-policy'] ?? null;
  } catch (e) {
    w.watch.add({ kind: 'setup', message: `navigation: ${String(e).split('\n')[0] ?? ''}` });
    return null;
  }
}

/** Records the twin's load (the inert content "x") and compares it with the committed map. */
async function twinBaseline(
  browser: Browser,
  request: APIRequestContext,
  project: string,
): Promise<{ recorded: Baseline; diff: string[] }> {
  const uid = await createTextBoard(request, unique('twin', project), [
    { ...PANEL, content: TWIN_CONTENT },
  ]);
  try {
    const w = await openWatched(browser, project);
    w.watch.record();
    await openCase(w, boardUrl(uid, [['env', 'prod']]));
    await learnMarkdownClasses(w.page);
    await w.watch.settle();
    await closeWatched(w);
    const recorded = w.watch.stopRecording();
    expect(w.watch.findings(), 'the twin loads cleanly').toEqual([]);
    if (UPDATE_BASELINE) writeBaseline(project, recorded);
    return { recorded, diff: compareBaseline(recorded, readBaseline(project)) };
  } finally {
    await deleteBoard(request, uid);
  }
}

async function pool<T>(items: readonly T[], n: number, run: (x: T) => Promise<void>) {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      const item = items[i];
      if (item !== undefined) await run(item);
    }
  };
  await Promise.all(Array.from({ length: n }, () => worker()));
}

test.describe('Text widget', () => {
  test.skip(PREVIEW, NEEDS_BFF);
  test.use({ baseURL: HTTP_BFF });

  test('e2e:widget-text', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    // A window of this test's own, so the fake's records of it are this run's.
    const from = Date.UTC(2026, 2, 1) + (info.workerIndex * 10 + info.retry) * 3_600_000;
    const to = from + 3_600_000;
    const time = `from=${encodeURIComponent(new Date(from).toISOString())}&to=${encodeURIComponent(new Date(to).toISOString())}&refresh=off`;
    const uid = await createTextBoard(request, unique('text', info.project.name), [
      {
        id: 'p-1',
        title: 'Runbook',
        content: '# R\n[S](https://s.test)\nEnv $env',
        grid: [0, 0, 6, 8],
      },
    ]);
    try {
      await page.goto(`/t/demo/board/${uid}?${time}&var-env=prod`);
      // The body region, named by the panel's heading (as is the panel's own section).
      const region = page.locator('[data-panel="p-1"] [data-text-body]');
      await expect(region).toHaveRole('region');
      await expect(region).toHaveAccessibleName('Runbook');
      await expect(region.locator('[data-text-content]')).toBeVisible();
      await expect(region.getByRole('heading', { level: 4, name: 'R' })).toBeVisible();
      const link = region.getByRole('link', { name: /^S/ });
      await expect(link).toHaveAttribute('href', 'https://s.test/');
      await expect(link).toHaveAttribute('target', '_blank');
      const rel = ((await link.getAttribute('rel')) ?? '').split(/\s+/).sort();
      expect(rel).toEqual(['nofollow', 'noopener', 'noreferrer']);
      await expect(region).toContainText('Env prod');

      // The filter bar's variable: env → dev.
      await page
        .getByRole('button', { name: t('filters.variable', { name: 'env', value: 'prod' }) })
        .click();
      const dialog = page.getByRole('dialog', {
        name: t('filters.variableTitle', { name: 'env' }),
      });
      await dialog.getByRole('textbox', { name: t('filters.value') }).fill('dev');
      await dialog.getByRole('button', { name: t('filters.apply') }).click();
      await expect(region).toContainText('Env dev');
      expect(await fakeRequests(request, { start: sec(from) }), 'a Text runs no query').toEqual([]);

      // Add widget → Text → `# Added` → Done → Save → reload.
      await page.getByRole('button', { name: 'Edit board' }).click();
      await page.getByRole('button', { name: t('board.addWidget'), exact: true }).click();
      await page.getByRole('menuitem', { name: t('widget.kind.text') }).click();
      const editor = page.getByRole('dialog', { name: t('widget.text.editTitle') });
      await editor.getByRole('textbox', { name: t('widget.text.content') }).fill('# Added');
      await expect(
        editor.getByRole('region', { name: /^Preview: / }).getByRole('heading', { level: 4 }),
      ).toHaveText('Added');
      await editor.getByRole('button', { name: t('editor.close') }).click();
      await expect(editor).toBeHidden();
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByRole('status', { name: 'Save status' })).toHaveText('Saved');
      await page.reload();
      await expect(page.locator('[data-text-content]')).toHaveCount(2);
      await expect(page.getByRole('heading', { level: 4, name: 'Added' })).toBeVisible();
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:widget-text-xss (a) the T24 row input', async ({ browser, page, request }, info) => {
    test.setTimeout(120_000);
    const project = info.project.name;
    const src = [
      '<script>window.__xss = 1; alert(1)</script>',
      '<img src=x onerror="window.__xss = 2; alert(2)">',
      '**ok**',
      '<iframe src="https://s.test/"></iframe>',
    ].join('\n\n');
    const uid = await createTextBoard(request, unique('xss-a', project), [
      { ...PANEL, content: src },
    ]);
    try {
      const w = await openWatched(browser, project);
      await trapDialogs(w.context);
      w.watch.begin(readBaseline(project), []);
      const csp = await openCase(w, boardUrl(uid, [['env', 'prod']]));
      expect(csp).toBe(CSP);
      await learnMarkdownClasses(w.page);
      expect(await checkCase(w.page, [])).toEqual([]);
      await expect(w.page.locator('[data-text-content]')).toHaveText('ok');
      expect(await trustedTypesCanary(w.page, w.watch)).toEqual([]);
      await w.watch.settle();
      await closeWatched(w);
      expect(w.watch.findings()).toEqual([]);

      // The editor lists the removals: two HTML blocks and the iframe.
      await page.goto(boardUrl(uid, [['env', 'prod']]));
      await page.getByRole('button', { name: 'Edit board' }).click();
      await page.getByRole('button', { name: t('panel.menu', { title: 'Text' }) }).click();
      await page.getByRole('menuitem', { name: t('panel.editPanel') }).click();
      const editor = page.getByRole('dialog', { name: t('widget.text.editTitle') });
      await expect(
        editor.getByRole('list', { name: t('widget.text.removals') }).getByRole('listitem'),
      ).toHaveText([
        t('markdown.removal.html', { line: 1 }),
        t('markdown.removal.html', { line: 3 }),
        t('markdown.removal.iframe', { line: 7 }),
      ]);
    } finally {
      await deleteBoard(request, uid);
    }
  });

  test('e2e:widget-text-xss (b) the corpus', async ({ browser, request }, info) => {
    test.setTimeout(15 * 60_000);
    const project = info.project.name;
    const started = Date.now();

    // 1. The committed case list is the generated one.
    const corpus = corpusInput();
    const committed = readCommittedCases();
    expect(compareCases(await generate(corpus), committed)).toEqual([]);
    expect(
      committed.map((c) => c.id),
      'one entry per corpus case',
    ).toEqual(corpus.map((c) => c.id));
    const byId = new Map<string, CorpusCase>(corpus.map((c) => [c.id, c]));

    // 2. The twin's load is the committed baseline, key by key and count by count.
    const { diff } = await twinBaseline(browser, request, project);
    expect(diff, 'BASELINE_UPDATE=1 rewrites the baselines; review the diff').toEqual([]);
    const baseline = readBaseline(project);

    // 3. Every eligible case, each alone in a fresh context on its own board.
    const eligible = committed.filter((c) => c.skip === null);
    const failures: string[] = [];
    let checked = 0;
    await pool(eligible, CONCURRENCY, async (e: E2eCase) => {
      const c = byId.get(e.id);
      if (c === undefined) {
        failures.push(`${e.id}: not in the corpus`);
        return;
      }
      const posted = await postTextBoard(request, unique(`xss ${c.id}`, project), [
        { ...PANEL, content: c.src },
      ]);
      const w = await openWatched(browser, project);
      const out: string[] = [];
      try {
        await trapDialogs(w.context);
        if ('error' in posted) {
          w.watch.add({ kind: 'setup', message: posted.error });
        } else {
          w.watch.begin(baseline, e.images);
          const csp = await openCase(w, boardUrl(posted.uid, c.vars));
          if (w.watch.findings().every((f) => f.kind !== 'setup')) {
            if (csp !== CSP) out.push(`CSP ${JSON.stringify(csp)}`);
            out.push(...(await checkCase(w.page, e.images)));
            out.push(...(await trustedTypesCanary(w.page, w.watch)));
            await w.watch.settle();
          }
        }
        await closeWatched(w);
      } finally {
        if (!('error' in posted)) await deleteBoard(request, posted.uid);
      }
      out.push(...w.watch.findings().map((f) => JSON.stringify(f)));
      checked += 1;
      for (const o of out) failures.push(`${e.id}: ${o}`);
    });
    info.annotations.push({
      type: 'e2e:widget-text-xss corpus',
      description: `${String(checked)} of ${String(committed.length)} cases checked (${String(committed.length - eligible.length)} skipped) in ${String(Math.round((Date.now() - started) / 1000))} s`,
    });
    expect(failures).toEqual([]);
    expect(checked).toBe(eligible.length);
  });

  test('e2e:widget-text-xss (c) the canaries', async ({ browser, request }, info) => {
    test.setTimeout(240_000);
    const project = info.project.name;
    const baseline = readBaseline(project);
    const boards = new Map<string, string>();
    const board = async (content: string): Promise<string> => {
      const had = boards.get(content);
      if (had !== undefined) return had;
      const uid = await createTextBoard(request, unique('canary', project), [
        { ...PANEL, content },
      ]);
      boards.set(content, uid);
      return uid;
    };
    /** One canary: a fresh watched context on `content`'s board, armed with `images`. */
    const canary = async (
      name: string,
      content: string,
      images: readonly string[],
      act: (w: Watched, uid: string) => Promise<void>,
      expected: readonly string[],
    ): Promise<void> => {
      const uid = await board(content);
      const w = await openWatched(browser, project);
      w.watch.begin(baseline, images);
      await openCase(w, boardUrl(uid, [['env', 'prod']]));
      await act(w, uid);
      await w.watch.settle();
      await closeWatched(w);
      expect.soft(lines(w.watch), name).toEqual([...expected].sort());
      expect
        .soft(() => {
          w.watch.assertClean();
        }, name)
        .toThrow();
    };
    const none = (): Promise<void> => Promise.resolve();
    try {
      await canary('c1', '![a](/l.svg)', [], none, ['request GET image /l.svg']);
      await canary('c2', '![a](/a.svg) ![b](/l.svg)', ['/a.svg'], none, [
        'request GET image /l.svg',
      ]);
      await canary(
        'c3',
        '![a](/a.svg)',
        ['/a.svg'],
        async (w) => {
          // Another CORS mode: the document's list of available images would otherwise answer a
          // second load of the same URL itself, whatever its caching headers say.
          await w.page.evaluate(() => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.src = '/a.svg';
          });
        },
        ['request GET image /a.svg'],
      );
      await canary('c4', '![a](/a.svg)', ['/a.svg', '/z.svg'], none, ['imageMissing /z.svg']);
      await canary(
        'c5',
        'x',
        [],
        async (w, uid) => {
          await w.page.evaluate((u) => fetch(`/api/dash/v1/boards/${u}`).catch(() => null), uid);
        },
        ['request GET fetch /api/dash/v1/boards/{uid}'],
      );
      await canary(
        'c6',
        'x',
        [],
        async (w) => {
          await w.page.evaluate(() => fetch('/api/dash/v1/boards').catch(() => null));
        },
        ['request GET fetch /api/dash/v1/boards'],
      );
      await canary(
        'c7',
        'x',
        [],
        async (w) => {
          await w.page.evaluate(async () => {
            const l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = '/assets/canary.css';
            document.head.append(l);
            await new FontFace('c', 'url(/assets/canary.woff2)').load().catch(() => null);
          });
        },
        ['request GET font /assets/canary.woff2', 'request GET stylesheet /assets/canary.css'],
      );
      // An unload-time beacon reaches request interception only in Firefox: Chromium and WebKit
      // send it outside the page's network stack (#198 Part 3b, deviation recorded in the PR).
      if (project === 'firefox') {
        await canary(
          'c8',
          'x',
          [],
          async (w) => {
            await w.page.evaluate(() => {
              addEventListener('pagehide', () => {
                navigator.sendBeacon('/__beacon', 'x');
              });
            });
          },
          ['request POST beacon /__beacon'],
        );
      }
      await canary(
        'c9',
        'x',
        [],
        async (w) => {
          await w.page.evaluate(() => {
            setTimeout(() => {
              void fetch('/__late').catch(() => null);
            }, 800);
          });
        },
        ['request GET fetch /__late'],
      );
      await canary(
        'c10',
        'x',
        [],
        async (w) => {
          await w.page.evaluate(() => navigator.serviceWorker.register('/sw.js').catch(() => null));
        },
        ['sw /sw.js'],
      );
      await canary(
        'c11',
        'x',
        [],
        async (w) => {
          await w.page.evaluate(() => {
            new Image().src = 'https://x.test/c11.png';
          });
        },
        // The browser's console line of the same violation is a finding too.
        ['console', 'csp img-src'],
      );
      await canary(
        'c12',
        'x',
        [],
        async (w) => {
          const consumed = await w.watch.consumeTrustedTypesCanary(async () => {
            await w.page.evaluate(() => {
              for (let i = 0; i < 2; i++) {
                try {
                  // Two sink writes inside one canary.
                  // eslint-disable-next-line no-restricted-syntax, security/no-html-sink
                  document.createElement('div').innerHTML = '<b>x</b>';
                } catch {
                  // Refused, as expected.
                }
              }
            });
          });
          expect.soft(consumed, 'c12 consumed').toBe(false);
        },
        ['console', 'console', 'csp require-trusted-types-for', 'csp require-trusted-types-for'],
      );
    } finally {
      for (const uid of boards.values()) await deleteBoard(request, uid);
    }
  });

  test('e2e:widget-a11y (Text)', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const long = Array.from({ length: 40 }, (_, i) => `Line ${String(i + 1)} of the runbook.`);
    const uid = await createTextBoard(request, unique('a11y', info.project.name), [
      {
        id: 'p-1',
        title: 'Runbook',
        content: `[First](/b/one) and [Second](/b/two)\n\n${long.join('\n\n')}`,
        grid: [0, 0, 6, 6],
      },
      { id: 'p-2', title: 'Note', content: 'Short.', grid: [6, 0, 6, 6] },
    ]);
    try {
      await page.goto(boardUrl(uid, [['env', 'prod']]));
      const runbook = page.locator('[data-panel="p-1"] [data-text-body]');
      const note = page.locator('[data-panel="p-2"] [data-text-body]');
      await expect(runbook).toHaveAccessibleName('Runbook');
      await expect(note).toHaveAccessibleName('Note');
      await expect(runbook.locator('[data-text-content]')).toBeVisible();
      await expect(note.locator('[data-text-content]')).toBeVisible();
      await expect(runbook).toHaveAttribute('tabindex', '0');
      await expect(note).not.toHaveAttribute('tabindex');
      // Firefox's content process crashes during or soon after an axe scan of this board (5 of 6
      // runs, with the `label` rule off or the scan scoped to the grid; never without axe): axe runs
      // in Chromium and WebKit, and every other step in all three.
      const axe = info.project.name !== 'firefox';
      if (axe) expect(await axeSerious(page)).toEqual([]);

      // T24-017: the panel menu, the region, then its links.
      await page.getByRole('button', { name: t('panel.menu', { title: 'Runbook' }) }).focus();
      await page.keyboard.press('Tab');
      await expect(runbook).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(runbook.getByRole('link', { name: /^First/ })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(runbook.getByRole('link', { name: /^Second/ })).toBeFocused();

      // The editor: the preview region and the over-limit status.
      await page.getByRole('button', { name: 'Edit board' }).click();
      await page.getByRole('button', { name: t('panel.menu', { title: 'Note' }) }).click();
      await page.getByRole('menuitem', { name: t('panel.editPanel') }).click();
      const editor = page.getByRole('dialog', { name: t('widget.text.editTitle') });
      const preview = editor.getByRole('region', {
        name: t('widget.text.previewLabel', { title: 'Note' }),
      });
      await expect(preview).toContainText('Short.');
      if (axe) expect(await axeSerious(page)).toEqual([]);
      await editor
        .getByRole('textbox', { name: t('widget.text.content') })
        .fill('x'.repeat(65_537));
      const status = preview.getByRole('status');
      await expect(status).toHaveText(
        t('widget.text.invalidPreview', { reason: 'Use at most 65 536 bytes.' }),
      );
      await expect(preview).toHaveAccessibleDescription(
        t('widget.text.invalidPreview', { reason: 'Use at most 65 536 bytes.' }),
      );
    } finally {
      await deleteBoard(request, uid);
    }
  });
});
