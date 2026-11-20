// Stub for the tests-first commit: the keyboard coverage harness follows.
import type { Page } from '@playwright/test';

export interface KeyboardHarness {
  press: (keys: string) => Promise<void>;
  type: (text: string) => Promise<void>;
  state: () => Promise<string>;
  focusName: () => Promise<string>;
  pendingHere: () => Promise<string[]>;
  collected: () => ReadonlySet<string>;
  operated: () => ReadonlySet<string>;
  uncovered: () => string[];
  unvisited: (required: readonly string[]) => string[];
}

export function parseSnapshot(yaml: string): string[] {
  throw new Error(`not implemented: ${yaml.length > 0 ? 'parseSnapshot' : ''}`);
}

export function keyboardHarness(page: Page): KeyboardHarness {
  throw new Error(`not implemented: ${page.url()}`);
}
