/**
 * A widget's body (plan #198 Part 1 §4.2; T24-002): a Text panel is its `TextBody` (Part 3a §4.2),
 * named by the frame's heading; the kinds this version does not draw yet (`PENDING_WIDGETS`) show
 * "not available yet". A2 draws Clock; #216 Part 2 the board list.
 */
import type { WidgetPanelSpec } from '../api/types';
import { t } from '../i18n/t';
import { EmptyState } from '../kit/EmptyState';
import { PENDING_WIDGETS } from './spec';
import { TextBody } from './text/TextBody';

export interface WidgetBodyProps {
  panel: WidgetPanelSpec;
  /** The id of the frame's heading, which names the body's region. */
  headingId: string;
  /** The board is in Edit mode. */
  editing: boolean;
}

export function WidgetBody({ panel, headingId, editing }: WidgetBodyProps) {
  if (panel.vis.kind === 'text') {
    return (
      <TextBody panel={panel} name={{ labelledBy: headingId }} editing={editing} context="board" />
    );
  }
  if (PENDING_WIDGETS.has(panel.vis.kind))
    return <EmptyState title={t('widget.kindUnavailable')} />;
  return null;
}
