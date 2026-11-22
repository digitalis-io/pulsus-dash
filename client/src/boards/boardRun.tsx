/** The board run context (plan #64 §3.4, A.14). */
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';

export function invalidatePanelEpoch(_qc: QueryClient, _tenant: string): void {
  throw new Error('not implemented');
}

export function BoardRunProvider(p: {
  tenant: string;
  vars: ReadonlyMap<string, string>;
  timeReady: boolean;
  children: ReactNode;
}) {
  return <>{p.children}</>;
}
