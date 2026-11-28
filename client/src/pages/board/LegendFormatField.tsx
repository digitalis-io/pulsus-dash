/**
 * The panel editor's Legend name field (#204; T08-007, T08-008): the panel's `vis.legendFormat`, a
 * template such as `{{instance}} select` naming each series by its labels. An empty field removes
 * the key (the full label set names the series). The hint lists the label names of the preview's
 * result, so the author sees what `{{label}}` can name.
 */
import { memo, useId } from 'react';
import type { DataPanelSpec } from '../../api/types';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { TextField } from '../../kit/TextField';
import styles from './Board.module.css';

/** The placeholder: an example template (a label name, not text to translate). */
const EXAMPLE = '{{instance}}';

/** The most label names the hint lists; more end in `…`. */
const HINT_LABELS = 20;

/** `vis` without `legendFormat` (absent, not undefined: the saved spec has no such key). */
function withoutFormat(vis: DataPanelSpec['vis']): DataPanelSpec['vis'] {
  return Object.fromEntries(
    Object.entries(vis).filter(([k]) => k !== 'legendFormat'),
  ) as DataPanelSpec['vis'];
}

export const LegendFormatField = memo(function LegendFormatField({
  vis,
  labels,
  error,
  readOnly,
  onVis,
}: {
  vis: DataPanelSpec['vis'];
  /** The label names of the preview's result, in order (`resultLabelNames`). */
  labels: readonly string[];
  error: string | null;
  readOnly: boolean;
  onVis: (next: DataPanelSpec['vis']) => void;
}) {
  const hintId = useId();
  const shown = labels.slice(0, HINT_LABELS).join(', ');
  const hint =
    labels.length === 0
      ? t('editor.legendFormat.hint')
      : t('editor.legendFormat.labels', {
          labels: labels.length > HINT_LABELS ? `${shown}, …` : shown,
        });
  return (
    // The unit field's column and hint styles: a field over its muted hint.
    <div className={cx(styles['unitField'])}>
      <TextField
        label={t('editor.legendFormat')}
        value={vis.legendFormat ?? ''}
        placeholder={EXAMPLE}
        onChange={(next) => {
          onVis(next === '' ? withoutFormat(vis) : { ...vis, legendFormat: next });
        }}
        error={error}
        isReadOnly={readOnly}
        autoComplete="off"
        spellCheck="false"
        mono
        aria-describedby={hintId}
      />
      <p id={hintId} className={cx(styles['unitHint'])}>
        {hint}
      </p>
    </div>
  );
});
