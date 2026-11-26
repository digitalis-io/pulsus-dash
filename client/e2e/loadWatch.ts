/**
 * The request and violation watch of the Text e2e (plan #198 Part 3b §3, §4.1; T24-018, T18-013).
 * One watch per browser context, opened by `openWatched`, which also sets the context rules:
 * service workers blocked, so the HTTP cache, storage and permissions are fresh per context; an
 * init script that records every `securitypolicyviolation` and turns
 * `ServiceWorkerContainer.prototype.register` into an `sw` finding and a rejection; the console
 * and page errors.
 *
 * Every request of the context passes the watch's route:
 *
 * - **idle** (before `begin` or `record`): it continues, unjudged.
 * - **recording** (`record` … `stopRecording`): it continues and counts against its key.
 * - **judged** (`begin(baseline, images)`): an `image` request whose path is in `images` is
 *   fulfilled once with a 1×1 PNG (`Cache-Control: no-store`); a second request of that path is a
 *   finding and is aborted. Any other request continues while its key's count stays within
 *   `baseline[key]`; past it, it is a finding and is aborted. `settle()` adds an `imageMissing`
 *   finding for every image path not requested by then.
 *
 * Not judged: `/favicon.ico`, and `POST /api/dash/v1/csp-report`, the browser's own report of a
 * violation that the init script has already recorded as a `csp` finding (Firefox and WebKit send
 * it at once, as `fetch` and `ping`).
 *
 * A key is `${method} ${resourceType} ${path}`: the path with its query, except a document's (no
 * query); a board uid after `board/`, `boards/` or `recent-boards/` becomes `{uid}`, and a built
 * asset's content hash (`/assets/index-BAs-TIQJ.js`) becomes `{hash}`, so a baseline names chunks,
 * not builds.
 *
 * This module imports no runtime code from `@playwright/test`, so the unit tests load it too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, ConsoleMessage, Page, Route } from '@playwright/test';
import { HTTP_BFF } from './bff.ts';

export type RequestKey = string;
export type Baseline = Readonly<Record<RequestKey, number>>;
export type LoadFinding =
  | { kind: 'request'; key: RequestKey }
  | { kind: 'imageMissing'; path: string }
  | { kind: 'csp'; directive: string; blocked: string }
  | { kind: 'console'; text: string }
  | { kind: 'pageerror'; message: string }
  | { kind: 'sw'; url: string }
  | { kind: 'setup'; message: string };

export interface LoadWatch {
  /** Judged from now: `baseline` bounds every key, `images` are the case's image paths. */
  begin(baseline: Baseline, images: readonly string[]): void;
  /** Recording mode: requests are counted, nothing is judged. */
  record(): void;
  /** Ends recording and returns the counts, keys sorted. */
  stopRecording(): Baseline;
  /**
   * Runs `act`; then removes exactly one csp `require-trusted-types-for` finding and exactly one
   * Trusted Types console finding raised during it; returns false (and removes nothing) unless
   * there is exactly one of each.
   */
  consumeTrustedTypesCanary(act: () => Promise<void>): Promise<boolean>;
  /** The observation window: 1 000 ms without a request, at least 2 000 ms, at most 10 s. */
  settle(): Promise<void>;
  /** A finding raised by the test itself (a failed setup step). */
  add(f: LoadFinding): void;
  findings(): readonly LoadFinding[];
  assertClean(): void;
}

export interface Watched {
  /** The Playwright project (browser) the watch's baseline belongs to. */
  readonly project: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly watch: LoadWatch;
}

/** The suite's fixed "now" (`helpers.ts` `T`), so time-stamped queries keep one key. */
const NOW = Date.UTC(2026, 10, 19, 13, 3);
const QUIET_MS = 1_000;
const MIN_MS = 2_000;
const MAX_MS = 10_000;
/** How long a canary waits for its violation and console line to arrive. */
const CANARY_WAIT_MS = 2_000;
const CANARY_EXTRA_MS = 300;
const PAGE_CLOSE_MS = 500;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const BOARD_UID = /^[0-9a-z]{14}$/;
const UID_PARENTS = new Set(['board', 'boards', 'recent-boards']);
const ASSET_HASH = /^(\/assets\/.+)-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/;
const CSP_OR_TT = /Content[- ]Security[- ]Policy|trusted[- ]?types|Trusted(?:HTML|Script)/i;
const TT_CONSOLE = /trusted/i;
const BINDING = '__pulsusLoadWatch';

/** The baseline files (`e2e/fixtures/board-load-baseline.<project>.json`). */
export function baselinePath(project: string): string {
  return fileURLToPath(new URL(`./fixtures/board-load-baseline.${project}.json`, import.meta.url));
}

export function readBaseline(project: string): Baseline {
  return JSON.parse(readFileSync(baselinePath(project), 'utf8')) as Baseline;
}

export function writeBaseline(project: string, b: Baseline): void {
  writeFileSync(baselinePath(project), `${JSON.stringify(sortedCounts(b), null, 2)}\n`);
}

function sortedCounts(b: Baseline): Record<RequestKey, number> {
  const out: Record<RequestKey, number> = {};
  for (const k of Object.keys(b).sort()) out[k] = b[k] ?? 0;
  return out;
}

/** The differences between a recorded map and a committed one, one per key, in key order. */
export function compareBaseline(recorded: Baseline, committed: Baseline): string[] {
  const keys = [...new Set([...Object.keys(recorded), ...Object.keys(committed)])].sort();
  const out: string[] = [];
  for (const k of keys) {
    const a = recorded[k] ?? 0;
    const b = committed[k] ?? 0;
    if (a !== b) out.push(`${k}: recorded ${String(a)}, committed ${String(b)}`);
  }
  return out;
}

/** The request's path as the image list and the keys hold it: pathname and search. */
export function requestPath(url: URL): string {
  return url.pathname + url.search;
}

export function requestKey(method: string, resourceType: string, url: URL): RequestKey {
  const segs = url.pathname.split('/');
  const path = segs
    .map((s, i) => (i > 0 && UID_PARENTS.has(segs[i - 1] ?? '') && BOARD_UID.test(s) ? '{uid}' : s))
    .join('/')
    .replace(ASSET_HASH, '$1-{hash}$2');
  return `${method} ${resourceType} ${resourceType === 'document' ? path : path + url.search}`;
}

function ignored(method: string, url: URL): boolean {
  return (
    url.pathname === '/favicon.ico' ||
    (method === 'POST' && url.pathname === '/api/dash/v1/csp-report')
  );
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms);
  });

type Mode = 'idle' | 'recording' | 'judged';

class Watch implements LoadWatch {
  private mode: Mode = 'idle';
  private counts = new Map<RequestKey, number>();
  private baseline: Baseline = {};
  private images = new Set<string>();
  private served = new Set<string>();
  private list: LoadFinding[] = [];
  private lastRequestAt = Date.now();

  begin(baseline: Baseline, images: readonly string[]): void {
    this.mode = 'judged';
    this.counts = new Map();
    this.baseline = baseline;
    this.images = new Set(images);
    this.served = new Set();
  }

  record(): void {
    this.mode = 'recording';
    this.counts = new Map();
  }

  stopRecording(): Baseline {
    this.mode = 'idle';
    return sortedCounts(Object.fromEntries(this.counts));
  }

  add(f: LoadFinding): void {
    this.list.push(f);
  }

  findings(): readonly LoadFinding[] {
    return this.list;
  }

  assertClean(): void {
    if (this.list.length > 0) {
      throw new Error(`load findings:\n${this.list.map((f) => JSON.stringify(f)).join('\n')}`);
    }
  }

  async consumeTrustedTypesCanary(act: () => Promise<void>): Promise<boolean> {
    const from = this.list.length;
    await act();
    const isCsp = (f: LoadFinding) =>
      f.kind === 'csp' && f.directive === 'require-trusted-types-for';
    const isConsole = (f: LoadFinding) => f.kind === 'console' && TT_CONSOLE.test(f.text);
    const raised = () => this.list.slice(from);
    const deadline = Date.now() + CANARY_WAIT_MS;
    while (Date.now() < deadline && !(raised().some(isCsp) && raised().some(isConsole))) {
      await sleep(50);
    }
    // A second violation (c12) arrives with the first: wait a little longer for it.
    await sleep(CANARY_EXTRA_MS);
    const csp = raised().filter(isCsp);
    const con = raised().filter(isConsole);
    const [c] = csp;
    const [m] = con;
    if (csp.length !== 1 || con.length !== 1 || c === undefined || m === undefined) return false;
    this.list = this.list.filter((f) => f !== c && f !== m);
    return true;
  }

  async settle(): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      const now = Date.now();
      if (now - t0 >= MAX_MS) break;
      if (now - t0 >= MIN_MS && now - this.lastRequestAt >= QUIET_MS) break;
      await sleep(50);
    }
    if (this.mode !== 'judged') return;
    for (const p of this.images) {
      if (!this.served.has(p)) this.add({ kind: 'imageMissing', path: p });
    }
  }

  /** The route handler of every request in the context. */
  async onRoute(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    const method = req.method();
    const type = req.resourceType();
    this.lastRequestAt = Date.now();
    try {
      if (ignored(method, url) || this.mode === 'idle') {
        await route.continue();
        return;
      }
      const key = requestKey(method, type, url);
      if (this.mode === 'judged' && type === 'image' && this.images.has(requestPath(url))) {
        const path = requestPath(url);
        if (this.served.has(path)) {
          this.add({ kind: 'request', key });
          await route.abort();
          return;
        }
        this.served.add(path);
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          headers: { 'Cache-Control': 'no-store' },
          body: PNG,
        });
        return;
      }
      const n = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, n);
      if (this.mode === 'judged' && n > (this.baseline[key] ?? 0)) {
        this.add({ kind: 'request', key });
        await route.abort();
        return;
      }
      await route.continue();
    } catch {
      // The page or context closed while the request was pending: nothing left to answer.
    }
  }

  onConsole(m: ConsoleMessage): void {
    const text = m.text();
    if (CSP_OR_TT.test(text)) this.add({ kind: 'console', text });
  }
}

/** The init script of every page in a watched context (runs before any page script). */
function initScript(binding: string): void {
  const report = (window as unknown as Record<string, (f: unknown) => Promise<void>>)[binding];
  const send = (f: unknown): void => {
    void report?.(f);
  };
  document.addEventListener('securitypolicyviolation', (e) => {
    send({
      kind: 'csp',
      directive: e.effectiveDirective || e.violatedDirective,
      blocked: e.blockedURI,
    });
  });
  if (typeof ServiceWorkerContainer !== 'undefined') {
    ServiceWorkerContainer.prototype.register = function register(url: string | URL) {
      send({ kind: 'sw', url: String(url) });
      return Promise.reject(new Error('service workers are blocked in a watched context'));
    };
  }
}

/** A fresh context (`serviceWorkers: 'block'`, the http-mode BFF) with its watch and one page. */
export async function openWatched(browser: Browser, project: string): Promise<Watched> {
  const context = await browser.newContext({
    baseURL: HTTP_BFF,
    serviceWorkers: 'block',
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1440, height: 900 },
  });
  const watch = new Watch();
  await context.clock.setFixedTime(NOW);
  await context.exposeBinding(BINDING, (_source, f: LoadFinding) => {
    watch.add(f);
  });
  await context.addInitScript(initScript, BINDING);
  await context.route('**/*', (route) => watch.onRoute(route));
  const page = await context.newPage();
  page.on('console', (m) => {
    watch.onConsole(m);
  });
  page.on('pageerror', (e) => {
    watch.add({ kind: 'pageerror', message: e.message });
  });
  return { context, page, watch, project };
}

/**
 * Unloads the page while it is still attached (a navigation to `about:blank`, so its `pagehide`
 * and `unload` requests pass the route), closes it with `runBeforeUnload`, then closes the
 * context; the watch judges every request until the context's `close` event.
 */
export async function closeWatched(w: Watched): Promise<void> {
  const closed = new Promise<void>((r) => {
    w.context.once('close', () => {
      r();
    });
  });
  try {
    await w.page.goto('about:blank');
  } catch {
    // Already closed.
  }
  const pageClosed = new Promise<void>((r) => {
    if (w.page.isClosed()) r();
    else
      w.page.once('close', () => {
        r();
      });
  });
  await w.page.close({ runBeforeUnload: true });
  // WebKit can take a minute to close a page after its unload handlers ran: the context's close
  // ends it.
  await Promise.race([pageClosed, sleep(PAGE_CLOSE_MS)]);
  await w.context.close();
  await closed;
}
