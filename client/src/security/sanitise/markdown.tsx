// STUB (tests-first commit): the exports of plan #198 Part 2b §3.1, without behaviour.
import type { ReactNode } from 'react';
import type { CodeLanguage } from '../../api/types';

export type RenderPolicy = 'board' | 'ai';
export type RemovalKind = 'html' | 'iframe' | 'linkScheme' | 'image' | 'unresolved' | 'depth';
export interface Removal {
  readonly kind: RemovalKind;
  readonly line: number;
}
export interface MarkdownEnv {
  readonly vars: ReadonlyMap<string, string>;
  readonly entity: string | null;
}
export interface MarkdownOpts {
  readonly policy: RenderPolicy;
  readonly appOrigin: string;
  readonly headingOffset?: number;
}
export const MAX_DEPTH = 32;

export function renderMarkdown(
  _src: string,
  _env: MarkdownEnv,
  _opts: MarkdownOpts,
): { node: ReactNode; removals: readonly Removal[] } {
  return { node: null, removals: [] };
}

export function renderCode(_src: string, _language: CodeLanguage): ReactNode {
  return null;
}

export function logRemovals(_panelId: string, _removals: readonly Removal[]): void {}

export function removalMessage(_r: Removal): string {
  return '';
}

export function sourceLines(_src: string, _start: number, _end: number): string {
  return '';
}

export function memoStats(): {
  readonly hits: number;
  readonly misses: number;
  readonly stackAfterWalk: number;
} {
  return { hits: 0, misses: 0, stackAfterWalk: -1 };
}
