/**
 * Inspector targets of the chart kinds (T25 §4.2, T25-002, plan #192 §3): the engine's `HoverItem`
 * of a click or a keyboard row, the `InspectorTarget` it names, and the selection it writes.
 */
import type { FrameData, HoverEvent, HoverItem, HoverRow, VisSpec } from '../engine/api';
import type { InspectorTarget, Selection } from '../inspector/types';

/** The keyboard crosshair's selected row as the engine's item (`toMsEnd`: the view's end). */
export function hoverItemOf(
  spec: VisSpec,
  data: FrameData,
  hover: HoverEvent,
  row: HoverRow,
  toMsEnd: number,
): HoverItem {
  void spec;
  void data;
  void hover;
  void row;
  void toMsEnd;
  throw new Error('todo');
}

export function targetOf(spec: VisSpec, data: FrameData, item: HoverItem): InspectorTarget {
  void spec;
  void data;
  void item;
  throw new Error('todo');
}

/** A stat's target: the first series' last finite sample, or the scalar (key null). */
export function statTarget(
  spec: Extract<VisSpec, { kind: 'stat' }>,
  data: FrameData,
): Extract<InspectorTarget, { type: 'value' }> {
  void spec;
  void data;
  throw new Error('todo');
}

/** The selection an inspect writes (T25 §4.2). */
export function selectionOf(t: InspectorTarget): Selection {
  void t;
  throw new Error('todo');
}
