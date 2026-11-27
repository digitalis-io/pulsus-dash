/**
 * Test support: the shared LogQL planner fixture `wire/fixtures/plan/logql.json` (plan #116 §3.5),
 * with its `Text` values expanded by the rules of `planFixture`. Imported by the mirror's tests
 * only.
 */
import raw from '../../../../wire/fixtures/plan/logql.json?raw';
import type { LogqlPlannedQuery } from '../../data/decode';
import type { FieldError } from '../types';
import { expand, type Text } from './planFixture';

export { expand, type Text };

export interface WireLogsPlanned {
  readonly query: Text;
  readonly expanded: Text;
  readonly bytes: number;
  readonly step_ms: number;
}

export interface LogsFacts {
  readonly class: 'pulsus_db' | 'virtual' | 'mixed';
  readonly reserved: readonly string[];
}

export interface LogsClassifyCase {
  readonly name: string;
  readonly text: Text;
  readonly vars?: Readonly<Record<string, string>>;
  /** The offset at which Prepare refuses the text with row 9b (plan #121 §3.3). */
  readonly prepare_position?: number;
  readonly want: LogsFacts & {
    readonly selectors: readonly { readonly reserved: boolean; readonly text: Text }[];
  };
}

export interface LogsPlanCase {
  readonly name: string;
  readonly from: string;
  readonly inputs: {
    readonly query: Text;
    readonly vars: Readonly<Record<string, string>>;
    readonly kind: 'range' | 'volume';
    readonly step_ms: number;
    readonly range_ms?: number;
  };
  readonly substituted?: Text;
  readonly want?: {
    readonly same_class?: boolean;
    readonly prepared?: LogsFacts;
    readonly planned?: LogsFacts;
  };
  readonly selectors?: readonly {
    readonly text: 'prepared' | 'planned';
    readonly from: number;
    readonly to: number;
    readonly reserved: boolean;
  }[];
  readonly planned?: WireLogsPlanned;
  readonly error?: {
    readonly status: 400 | 413;
    readonly message: string;
    readonly fields: readonly { readonly pointer: string; readonly message_key: string }[];
    /** Row 9b's byte offset into the raw text (plan #121 §3.3): `hint.position.offset`. */
    readonly position?: number;
    readonly hint?: { readonly reason: 'processing_cap' };
    readonly planned?: WireLogsPlanned;
  };
  readonly to_source?: readonly (readonly [number, number | null])[];
}

export interface LogsFixture {
  readonly version: number;
  readonly classify: readonly LogsClassifyCase[];
  readonly plan: readonly LogsPlanCase[];
  readonly reserved: readonly { readonly text: Text; readonly want: string | null }[];
  readonly rate_window: readonly { step_ms: number; window_ms: number; text: string }[];
  readonly durations: readonly { ms: number; text: string }[];
  readonly volume_range: readonly { step_ms: number; text: string }[];
}

export const LOGS_FIXTURE = JSON.parse(raw) as LogsFixture;

/** The camel-case `LogqlPlannedQuery` of a fixture plan. */
export function logsPlannedOf(p: WireLogsPlanned): LogqlPlannedQuery {
  return {
    query: expand(p.query),
    expanded: expand(p.expanded),
    bytes: p.bytes,
    stepMs: p.step_ms,
  };
}

export function logsFieldsOf(fs: NonNullable<LogsPlanCase['error']>['fields']): FieldError[] {
  return fs.map((f) => ({ pointer: f.pointer, messageKey: f.message_key }));
}
