/**
 * The panel editor's Unit field (#290 §4.4; T22-015, T08-007, T08-008): a Select of Auto and the
 * unit catalogue in its five groups, each option named with an example in its unit (`Bytes/s (IEC)
 * · 1.5 KiB/s`); a Suffix text field for Custom; and, when the preview's query is rated and the
 * rewrite changes the unit, the hint of the unit the panel shows (on a heatmap, drawn or resolved
 * by Auto: its bucket bounds stay in the unit and only its counts are per second). Auto removes `vis.unit`; Custom
 * writes `{id: 'custom', suffix: ''}`, invalid until a suffix is typed. The Suffix field shows the
 * server's errors at `…/vis/unit` and `…/vis/unit/suffix`, and its own check meanwhile; for any
 * other unit the Select shows the error at `…/vis/unit` (an older server's refusal).
 */
import { memo, useMemo } from 'react';
import type { DataPanelSpec } from '../../api/types';
import { formatValue, unitLabel } from '../../i18n/format';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { Select, type SelectOption } from '../../kit/Select';
import { TextField } from '../../kit/TextField';
import type { VisKind } from '../../engine/api';
import {
  isUnitSuffix,
  rated,
  UNIT_CATALOGUE,
  unitEntry,
  unitOf,
  type UnitId,
} from '../../vis/units';
import styles from './Board.module.css';

type Vis = DataPanelSpec['vis'];
type Choice = UnitId | 'auto';

export interface UnitFieldProps {
  readonly vis: Vis;
  /** The preview's query was rated (`planned.rateApplied`): the hint shows the rated unit. */
  readonly rateApplied: boolean;
  /**
   * The kind the preview draws after Auto resolution (`chooseVis`), or null before it has drawn
   * (then the stored kind decides): a heatmap's bucket bounds keep the unit (T22-015).
   */
  readonly drawnKind: VisKind | null;
  /** The field error under `…/vis/unit`: `suffix` is `''`, `'/id'` or `'/suffix'`. */
  readonly errorAt: (suffix: string) => string | null;
  readonly readOnly: boolean;
  readonly onVis: (next: Vis) => void;
}

/** `vis` without its unit (absent, not undefined: the saved spec has no such key). */
function withoutUnit(vis: Vis): Vis {
  return Object.fromEntries(Object.entries(vis).filter(([k]) => k !== 'unit')) as Vis;
}

function options(): SelectOption<Choice>[] {
  return [
    { id: 'auto', label: t('editor.unit.auto') },
    ...UNIT_CATALOGUE.map((e) => ({
      id: e.id,
      label:
        e.example === null || e.unit === null
          ? t(e.label)
          : t('editor.unit.option', { name: t(e.label), example: formatValue(e.example, e.unit) }),
      group: t(`unit.group.${e.group}`),
    })),
  ];
}

export const UnitField = memo(function UnitField({
  vis,
  rateApplied,
  drawnKind,
  errorAt,
  readOnly,
  onVis,
}: UnitFieldProps) {
  const choices = useMemo(options, []);
  const unit = vis.unit;
  const custom = unit?.id === 'custom';
  const suffix = unit?.suffix ?? '';
  const suffixError =
    errorAt('/suffix') ??
    errorAt('') ??
    (custom && !isUnitSuffix(suffix) ? t('field.board.unit.suffix.invalid') : null);
  const heatmap = (drawnKind ?? vis.kind) === 'heatmap';
  const hint = useMemo(() => {
    if (!rateApplied || unit === undefined) return null;
    const u = unitOf(unit);
    // T22-015: a rated heatmap keeps its bucket bounds in the unit; only its counts are per second.
    if (heatmap) {
      const name = unitLabel(u) ?? t(unitEntry(unit.id)?.label ?? 'unit.id.count');
      return t('editor.unit.ratedHeatmap', { unit: name });
    }
    const r = rated(u);
    return JSON.stringify(r) === JSON.stringify(u)
      ? null
      : t('editor.unit.rated', { unit: unitLabel(r) ?? '' });
  }, [rateApplied, unit, heatmap]);
  return (
    <div className={cx(styles['unitField'])}>
      <Select<Choice>
        label={t('editor.unit')}
        value={unit === undefined ? 'auto' : (unit.id as UnitId)}
        options={choices}
        onChange={(id) => {
          if (id === 'auto') onVis(withoutUnit(vis));
          else if (id === 'custom') onVis({ ...vis, unit: { id, suffix: custom ? suffix : '' } });
          else onVis({ ...vis, unit: { id } });
        }}
        error={errorAt('/id') ?? (custom ? null : errorAt(''))}
        isDisabled={readOnly}
      />
      {custom && (
        <TextField
          label={t('editor.unit.suffix')}
          value={suffix}
          onChange={(next) => {
            onVis({ ...vis, unit: { id: 'custom', suffix: next } });
          }}
          error={suffixError}
          isReadOnly={readOnly}
          autoComplete="off"
        />
      )}
      {hint !== null && <p className={cx(styles['unitHint'])}>{hint}</p>}
    </div>
  );
});
