/**
 * The Inspector contract (T25 §5): the origin of an inspect, the target union every kind emits, the
 * shared selection and the request the host receives. Every field is `readonly`. A new kind adds a
 * member to `InspectorTarget` and a case to `inspectorModel` (T25-002).
 */
import type { LogLevel } from '../data/logFrame';
import type { CategoryRow, Mark } from '../data/frames';
import type { FrameSelection, TimeWindow, Unit } from '../engine/api';
import type { BoardFilter } from '../state/boardParams';
import type { ContextSearch } from '../state/contextSearch';
import type { State } from '../theme/stateEncoding';
import type { GeoInspectorTarget } from '../vis/geo/targets';
import type { MemberSection } from './members';

export type Labels = Readonly<Record<string, string>>;

export interface InspectOrigin {
  readonly surface: 'board' | 'explore';
  /** The board panel; null on Explore. */
  readonly panelId: string | null;
  readonly title: string;
  /** Board: the panel's `run.expanded`; Explore: `q`; null before a run. */
  readonly query: { readonly lang: 'promql' | 'logql'; readonly text: string } | null;
  readonly window: TimeWindow;
  readonly unit: Unit | null;
}

/** A bar's inspect (T25-002, T22 §5.1): the mark, its panel and the window it was reduced over. */
export interface InspectTarget {
  readonly panelId: string | null;
  readonly kind: 'barchart';
  readonly title: string;
  readonly mark: Mark;
  readonly members: CategoryRow['members'];
  readonly unit: Unit;
  readonly window: TimeWindow;
  readonly query: { readonly lang: 'promql' | 'logql'; readonly text: string } | null;
}

/** I1's targets and #173's `mark` (T25 §5); #170 adds `stateRun`, #177 `flame`. */
export type InspectorTarget =
  | {
      readonly type: 'point';
      readonly vis: 'line' | 'bars';
      readonly key: string;
      readonly labels: Labels;
      readonly name: string;
      readonly tMs: number;
      readonly value: number;
    }
  | {
      readonly type: 'bucket';
      /** The bound index. */
      readonly index: number;
      readonly tMs: number;
      readonly toMs: number;
      readonly lower: number | null;
      readonly upper: number;
      readonly count: number;
      readonly countUnit: Unit;
    }
  | {
      readonly type: 'value';
      readonly key: string | null;
      readonly labels: Labels;
      readonly name: string;
      readonly value: number;
      readonly tMs: number | null;
      readonly state: State | null;
    }
  | {
      readonly type: 'logLine';
      readonly streamKey: string;
      readonly labels: Labels;
      readonly tsNs: bigint;
      readonly level: LogLevel;
      readonly line: string;
      readonly metadata: Labels | null;
      readonly parsed: Labels | null;
    }
  | { readonly type: 'mark'; readonly target: InspectTarget }
  /** A geomap mark, cluster, aggregate or group (T25 §4.9, T24 §5.16; #234 Part 3). */
  | { readonly type: 'geo'; readonly target: GeoInspectorTarget };

/** The page selection: the engine seam's `FrameSelection` (ADR-0025). */
export type Selection = FrameSelection;

export interface SelectionSource {
  readonly kind: 'mark' | 'tableRow' | 'brush' | 'member';
  readonly panelId: string | null;
}

export interface InspectRequest {
  readonly origin: InspectOrigin;
  readonly target: InspectorTarget;
  readonly selection: Selection;
  readonly source: 'pointer' | 'keyboard';
  readonly returnFocus: HTMLElement | null;
}

export type PivotId = 'explore' | 'logs' | 'traces' | 'profiles' | 'entity' | 'labelFilter';

export interface Pivot {
  readonly id: PivotId;
  readonly label: string;
  /** Null when unavailable. */
  readonly href: string | null;
  /** Set ⇔ `href` is null. */
  readonly reason: string | null;
  /** Filter keys this pivot does not carry (logs). */
  readonly notCarried: readonly string[];
  /** The Context lines under an enabled chip (T25-010); [] for a disabled one. */
  readonly context: readonly string[];
}

export interface PivotContext {
  readonly search: ContextSearch;
  /** Board `f=`, in URL order; [] on Explore. */
  readonly filters: readonly BoardFilter[];
}

export interface InspectorEnv {
  readonly tenant: string;
  readonly ctx: PivotContext;
  readonly timeZone: string;
  readonly capabilities: {
    readonly investigations: boolean;
    readonly alerting: boolean;
    readonly ai: boolean;
  };
}

export interface InspectorFact {
  readonly label: string;
  readonly value: string;
}

export interface InspectorAction {
  readonly id: 'pin' | 'alert' | 'ai';
  readonly label: string;
  /** Why it is disabled; null when enabled. */
  readonly reason: string | null;
}

export interface InspectorModel {
  readonly heading: string;
  /** `formatClockMs(t)`, or '' without an instant. */
  readonly subheading: string;
  readonly primary: string;
  readonly primaryKind: 'value' | 'line';
  /** A crossed threshold's state (colour and glyph), else null. */
  readonly primaryState: State | null;
  readonly facts: readonly InspectorFact[];
  /** By key. */
  readonly labels: readonly (readonly [string, string])[];
  readonly extraLabels: readonly {
    readonly title: 'Metadata' | 'Parsed';
    readonly labels: readonly (readonly [string, string])[];
  }[];
  readonly members: MemberSection | null;
  readonly pivots: readonly Pivot[];
  readonly query: { readonly lang: 'PromQL' | 'LogQL'; readonly text: string } | null;
  readonly actions: readonly InspectorAction[];
  readonly announce: string;
  readonly copyValue: string;
}
