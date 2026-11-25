/**
 * `inspectorModel` (T25-003, T25-004, T25-009, T25-010, T25-015): one pure function renders every
 * target into the Inspector's fixed sections.
 */
import type { InspectorEnv, InspectorModel, InspectRequest } from './types';

export function inspectorModel(req: InspectRequest, env: InspectorEnv): InspectorModel {
  void req;
  void env;
  throw new Error('todo');
}
