/** Stub (tests first): plan #198 Part 3a §3.2. */
import type { WidgetPanelSpec } from '../../api/types';
import type { TextOptions } from '../spec';

export function textVis(
  _o: TextOptions,
  original: WidgetPanelSpec['vis'] | undefined,
): WidgetPanelSpec['vis'] {
  return original ?? { kind: 'text' };
}
