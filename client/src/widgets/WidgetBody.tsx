/**
 * A widget's body (plan #198 Part 1 §4.2; T24-002): the kinds this version does not draw yet
 * (`PENDING_WIDGETS`) show "not available yet". Part 3 draws Text; A2 draws Clock.
 */
import type { WidgetPanelSpec } from '../api/types';
import { t } from '../i18n/t';
import { EmptyState } from '../kit/EmptyState';
import { PENDING_WIDGETS } from './spec';

export function WidgetBody({ panel }: { panel: WidgetPanelSpec }) {
  if (PENDING_WIDGETS.has(panel.vis.kind))
    return <EmptyState title={t('widget.kindUnavailable')} />;
  return null;
}
