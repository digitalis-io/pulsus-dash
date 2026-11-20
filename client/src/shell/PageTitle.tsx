// Stub for the tests-first commit: the implementation follows.
/**
 * The page title shown in the header `<h1>` and in `document.title` ("<title> · Pulsus Dash").
 * Pages call `usePageTitle(title)`; outside the shell only `document.title` is set.
 */
import { type ReactNode } from 'react';

export function PageTitleProvider({
  children,
}: {
  children: ReactNode;
}): import('react').JSX.Element {
  throw new Error('not implemented');
}

export function usePageTitle(title: string): void {
  throw new Error('not implemented');
}

export function usePageTitleValue(): string {
  throw new Error('not implemented');
}
