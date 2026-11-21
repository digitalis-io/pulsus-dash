/** Stub (tests first, plan #63 Part C §3.1). */
import type { RefCallback } from 'react';

export function useElementWidth<T extends HTMLElement>(): readonly [RefCallback<T>, number | null] {
  throw new Error('not implemented');
}
