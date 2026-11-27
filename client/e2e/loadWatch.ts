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
 * - **judged** (`begin(baseline, images)`): a same-origin `image` request whose path is in `images`
 *   (`isPermittedImage`) is fulfilled once with a 1×1 PNG (`Cache-Control: no-store`); a second request of that path is a
 *   finding and is aborted. Any other request continues while its key's count stays within
 *   `baseline[key]`; past it, it is a finding and is aborted. `settle()` adds an `imageMissing`
 *   finding for every image path not requested by then.
 *
 * Not judged (`isExempt`): the app origin's `/favicon.ico`, and a browser's own CSP violation report
 * (`isBrowserCspReport`) of a violation that the init script has already recorded as a `csp`
 * finding (Firefox and WebKit send it at once, as `fetch` and `ping`). Any other request to the
 * report path, and any request to another origin, is judged.
 *
 * A key is `${method} ${resourceType} ${path}`: the path with its query, except a document's (no
 * query); a board uid after `board/`, `boards/` or `recent-boards/` becomes `{uid}`, and a built
 * asset's content hash (`/assets/index-BAs-TIQJ.js`) becomes `{hash}`, so a baseline names chunks,
 * not builds. A request to another origin than the app's keeps that origin before its path
 * (plan #263), so it never matches a committed key, which is always a same-origin path.
 *
 * This module imports no runtime code from `@playwright/test`, so the unit tests load it too.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Page,
  Request,
  Route,
} from '@playwright/test';
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
  /** Waits until 500 ms pass without a request from its start, at most 2 s (`closeWatched`'s unload window). */
  drain(): Promise<void>;
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
const DRAIN_QUIET_MS = 500;
const DRAIN_MAX_MS = 2_000;
const RECENT_PATH = '/api/dash/v1/me/recent-boards/';
const RECENT_WAIT_MS = 5_000;

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

/** The origin every watched context loads (`openWatched`: the http-mode BFF). */
const APP_ORIGIN = new URL(HTTP_BFF).origin;

export function requestKey(method: string, resourceType: string, url: URL): RequestKey {
  const segs = url.pathname.split('/');
  const path = segs
    .map((s, i) => (i > 0 && UID_PARENTS.has(segs[i - 1] ?? '') && BOARD_UID.test(s) ? '{uid}' : s))
    .join('/')
    .replace(ASSET_HASH, '$1-{hash}$2');
  const full = resourceType === 'document' ? path : path + url.search;
  return `${method} ${resourceType} ${url.origin === APP_ORIGIN ? full : url.origin + full}`;
}

const CSP_REPORT_PATH = '/api/dash/v1/csp-report';

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * True only for a browser's CSP violation report: a same-origin `POST` to exactly the report path
 * with no query, a report content type, and a body that parses as a violation report
 * (`application/csp-report`: `{"csp-report": {…}}` or, as WebKit sends it, one
 * `{type: "csp-violation", body: {…}}`; `application/reports+json`: a non-empty array of those). Anything else to that path is judged as a request.
 */
export function isBrowserCspReport(
  method: string,
  url: URL,
  contentType: string | undefined,
  body: string | null,
): boolean {
  if (method !== 'POST' || url.origin !== APP_ORIGIN) return false;
  if (url.pathname !== CSP_REPORT_PATH || url.search !== '' || body === null) return false;
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  let doc: unknown;
  try {
    doc = JSON.parse(body);
  } catch {
    return false;
  }
  const violation = (r: unknown): boolean =>
    isObject(r) && r['type'] === 'csp-violation' && isObject(r['body']);
  // WebKit sends one Reporting API report under the legacy type.
  if (type === 'application/csp-report') {
    return isObject(doc) && (isObject(doc['csp-report']) || violation(doc));
  }
  if (type === 'application/reports+json') {
    return Array.isArray(doc) && doc.length > 0 && doc.every(violation);
  }
  return false;
}

/**
 * True for a request the watch never judges: the app origin's `/favicon.ico`, or a browser's CSP
 * violation report (`isBrowserCspReport`). Plan #263: another origin's favicon is judged.
 */
export function isExempt(
  method: string,
  url: URL,
  contentType?: string,
  body: string | null = null,
): boolean {
  return (
    (url.origin === APP_ORIGIN && url.pathname === '/favicon.ico') ||
    isBrowserCspReport(method, url, contentType, body)
  );
}

/**
 * True for one of the case's image requests, which the watch fulfils once: an `image` from the app
 * origin whose path is in `images`. Plan #263: another origin's image of that path is judged
 * against the baseline, where it has no key.
 */
export function isPermittedImage(type: string, url: URL, images: ReadonlySet<string>): boolean {
  return type === 'image' && url.origin === APP_ORIGIN && images.has(requestPath(url));
}

function ignored(req: Request, url: URL): boolean {
  return isExempt(req.method(), url, req.headers()['content-type'], req.postData());
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
  private recentRead: Promise<void>;
  private markRecentRead!: () => void;

  constructor() {
    this.recentRead = new Promise<void>((r) => {
      this.markRecentRead = r;
    });
  }

  /** A `GET` of the recent-boards list has completed. */
  recentListed(): void {
    this.markRecentRead();
  }

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

  async drain(): Promise<void> {
    const t0 = Date.now();
    // Quiet is counted from the later of the drain's start and the last request, so a request the
    // unload sends just after the navigation still lands inside the window.
    const quiet = () => Date.now() - Math.max(t0, this.lastRequestAt) >= DRAIN_QUIET_MS;
    while (Date.now() - t0 < DRAIN_MAX_MS && !quiet()) await sleep(50);
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
    // Sequencing: the board's recent-view write is answered after the first recent-boards read, so
    // the list is always read twice (before and after the write) and the count is stable.
    if (method === 'PUT' && url.pathname.startsWith(RECENT_PATH)) {
      await Promise.race([this.recentRead, sleep(RECENT_WAIT_MS)]);
    }
    try {
      if (ignored(req, url) || this.mode === 'idle') {
        await route.continue();
        return;
      }
      const key = requestKey(method, type, url);
      if (this.mode === 'judged' && isPermittedImage(type, url, this.images)) {
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
  context.on('requestfinished', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/dash/v1/me/recent-boards') {
      watch.recentListed();
    }
  });
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
    await w.watch.drain();
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
