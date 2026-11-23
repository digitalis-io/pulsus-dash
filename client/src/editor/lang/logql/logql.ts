/**
 * LogQL as a `QueryLanguage` (T09 §5.1, ADR-0018; plan #66 Part A §3.7): the editor extensions
 * (`extensions.ts`) over the lookups of `logSource.ts`, and the run diagnostics shared with PromQL
 * (the server reports positions in the raw text, ADR-0021 §3). The shape claims nothing: LogQL has
 * one range route, and whether a query is a log or metric query is the response's `kind`
 * (ADR-0021 §4). Nothing here decides whether a query is valid: PulsusDB does (T09-002).
 */
import { positionDiagnostics } from '../diagnostics';
import { UNKNOWN_SHAPE, type QueryLanguage } from '../types';
import { logqlExtensions } from './extensions';
import { createLogSource } from './logSource';

export const logql: QueryLanguage = {
  lang: 'logql',
  editor: (deps) => logqlExtensions(createLogSource(deps)),
  shape: () => UNKNOWN_SHAPE,
  diagnosticsOf: positionDiagnostics,
  // ⌘K detection (INT-038) is not built yet: LogQL claims no prefix.
  detect: () => 0,
};
