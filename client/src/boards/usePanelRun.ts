/** The panel run hook (plan #64 §3.2). */
import type { PanelSpec, PlannedQuery } from '../api/types';
import type { Diagnostic } from '../editor/lang/types';
import type { Refusal } from '../explore/useExploreRun';
import type { ExploreResult } from '../vis/autovis';
import type { PanelState } from './panelRun';

export interface PanelRunInput {
  readonly tenant: string;
  readonly panel: PanelSpec;
  readonly text: string;
  readonly enabled: boolean;
  readonly widthPx: number | null;
}

export interface PanelOutcome {
  readonly key: readonly unknown[];
  readonly planned: PlannedQuery;
  readonly result: ExploreResult;
}

export interface PanelRun {
  /** The text this run is for (`diagnostics` index into it). */
  readonly text: string;
  readonly blocked: PanelState | null;
  readonly missing: readonly string[];
  readonly refusal: Refusal | null;
  readonly ready: boolean;
  readonly outcome: PanelOutcome | null;
  readonly error: unknown;
  readonly diagnostics: readonly Diagnostic[];
  readonly fetching: boolean;
  readonly stepMs: number | null;
  readonly expanded: string | null;
}

export function usePanelRun(_a: PanelRunInput): PanelRun {
  throw new Error('not implemented');
}
