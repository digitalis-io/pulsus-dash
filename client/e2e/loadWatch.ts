/* eslint-disable @typescript-eslint/no-unused-vars -- stubs until the implementation (tests first) */
/** The request and violation watch of the Text e2e (#198 Part 3b): stub until the implementation. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from '@playwright/test';
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
  begin(baseline: Baseline, images: readonly string[]): void;
  record(): void;
  stopRecording(): Baseline;
  consumeTrustedTypesCanary(act: () => Promise<void>): Promise<boolean>;
  settle(): Promise<void>;
  add(f: LoadFinding): void;
  findings(): readonly LoadFinding[];
  assertClean(): void;
}

export interface Watched {
  readonly project: string;
  readonly context: BrowserContext;
  readonly page: Page;
  readonly watch: LoadWatch;
}

export function baselinePath(project: string): string {
  return fileURLToPath(new URL(`./fixtures/board-load-baseline.${project}.json`, import.meta.url));
}

export function readBaseline(project: string): Baseline {
  const p = baselinePath(project);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Baseline) : {};
}

export function writeBaseline(project: string, b: Baseline): void {
  writeFileSync(baselinePath(project), `${JSON.stringify(b, null, 2)}\n`);
}

export function compareBaseline(_recorded: Baseline, _committed: Baseline): string[] {
  return [];
}

class Watch implements LoadWatch {
  begin(): void {
    // Stub.
  }
  record(): void {
    // Stub.
  }
  stopRecording(): Baseline {
    return {};
  }
  async consumeTrustedTypesCanary(act: () => Promise<void>): Promise<boolean> {
    await act();
    return false;
  }
  settle(): Promise<void> {
    return Promise.resolve();
  }
  add(): void {
    // Stub.
  }
  findings(): readonly LoadFinding[] {
    return [];
  }
  assertClean(): void {
    // Stub.
  }
}

export async function openWatched(browser: Browser, project: string): Promise<Watched> {
  const context = await browser.newContext({ baseURL: HTTP_BFF });
  const page = await context.newPage();
  return { project, context, page, watch: new Watch() };
}

export async function closeWatched(w: Watched): Promise<void> {
  await w.context.close();
}
