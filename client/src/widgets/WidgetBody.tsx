/**
 * A widget's body (plan #198 Part 1 §4.2; T24-002): a Text panel is its `TextBody` (Part 3a §4.2)
 * and a Board list its `BoardListBody` (plan #216 Part 2a §4.2), each named by the frame's heading;
 * the kinds this version does not draw yet (`PENDING_WIDGETS`) show "not available yet". A2 draws
 * Clock.
 */
import type { WidgetPanelSpec } from '../api/types';
import { t } from '../i18n/t';
import { EmptyState } from '../kit/EmptyState';
import { BoardListBody } from './boardList/BoardListBody';
import { PENDING_WIDGETS } from './spec';
import { TextBody } from './text/TextBody';

export interface WidgetBodyProps {
  panel: WidgetPanelSpec;
  /** The id of the frame's heading, which names the body's region. */
  headingId: string;
  /** The board is in Edit mode. */
  editing: boolean;
  /** A `TABLE_WIDGETS` kind's table view is shown. */
  table?: boolean;
  onTable?: (on: boolean) => void;
}

const NO_TABLE = (): void => undefined;

export function WidgetBody({ panel, headingId, editing, table, onTable }: WidgetBodyProps) {
  if (panel.vis.kind === 'text') {
    return (
      <TextBody panel={panel} name={{ labelledBy: headingId }} editing={editing} context="board" />
    );
  }
  if (panel.vis.kind === 'boardList') {
    return (
      <BoardListBody
        panel={panel}
        headingId={headingId}
        editing={editing}
        table={table ?? false}
        onTable={onTable ?? NO_TABLE}
      />
    );
  }
  if (PENDING_WIDGETS.has(panel.vis.kind))
    return <EmptyState title={t('widget.kindUnavailable')} />;
  return null;
}
