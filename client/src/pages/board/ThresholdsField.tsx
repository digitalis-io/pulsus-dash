/**
 * The panel editor's Thresholds (plan #64 Part B §3.10, §4.6): up to 8 absolute steps, each a
 * value, a state and a label, and the direction in which values are worse. Every change goes to the
 * draft at once. The Value text is the row's own: an unparsable text stores NaN and shows "Enter a
 * number", and a value out of the range (0, or 1e-9 to 1e15 in size) is stored as typed and shows
 * the range error; the save then stops on the draft's check (§4.6). Rows are memoised by index, so
 * a keystroke renders one row (R5). When the field mounts (the editor opens), its rows are revealed
 * over the next animation frames, `ROWS_PER_FRAME` at a time, so opening the editor on a panel
 * with 8 thresholds is not one long task (`bench:rooms-long-tasks`, as the PromQL editor view mounts
 * a frame after its field); a row added after that renders at once.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { inThresholdRange } from '../../boards/spec';
import { fieldMessage } from '../../boards/fieldMessages';
import type { Unit } from '../../engine/api';
import { t, type MessageId } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { IconButton } from '../../kit/IconButton';
import { Select } from '../../kit/Select';
import { TextField } from '../../kit/TextField';
import {
  displayText,
  MAX_THRESHOLD_STEPS,
  type Thresholds,
  type ThresholdStep,
} from '../../vis/thresholds';
import styles from './Board.module.css';

export interface ThresholdsFieldProps {
  readonly value: Thresholds | undefined;
  /** undefined removes `vis.thresholds`. */
  readonly onChange: (t: Thresholds | undefined) => void;
  /** Field errors of the last invalid save, by pointer suffix under `/vis/thresholds`. */
  readonly errorAt: (suffix: string) => string | null;
  readonly unit: Unit; // the preview frame's unit, else { kind: 'none' }: label placeholders
  readonly readOnly: boolean;
}

const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Rows mounted per animation frame while the field reveals its rows after mounting. */
const ROWS_PER_FRAME = 2;

/**
 * How many of `total` rows to render: none in the mount's own task, then `ROWS_PER_FRAME` more
 * per animation frame until every row present then is shown; from then on, all of them.
 */
function useRevealedRows(total: number): number {
  const [revealed, setRevealed] = useState<number | 'all'>(0);
  const totalRef = useRef(total);
  useLayoutEffect(() => {
    totalRef.current = total;
  });
  useEffect(() => {
    if (revealed === 'all') return;
    const id = requestAnimationFrame(() => {
      setRevealed((r) => {
        if (r === 'all') return r;
        const next = r + ROWS_PER_FRAME;
        return next >= totalRef.current ? 'all' : next;
      });
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [revealed]);
  return revealed === 'all' ? total : Math.min(revealed, total);
}

/** The value of a Value text: a finite number, else NaN. */
function parse(text: string): number {
  const s = text.trim();
  if (!NUMBER.test(s)) return NaN;
  const v = Number(s);
  return Number.isFinite(v) ? v : NaN;
}

const textOf = (v: number): string => (Number.isNaN(v) ? '' : String(v));

const STATES: readonly { id: ThresholdStep['state']; label: MessageId }[] = [
  { id: 'watch', label: 'state.watch' },
  { id: 'degraded', label: 'state.degraded' },
  { id: 'failing', label: 'state.failing' },
];

interface RowProps {
  readonly index: number;
  readonly step: ThresholdStep;
  readonly direction: Thresholds['direction'];
  readonly unit: Unit;
  readonly readOnly: boolean;
  readonly valueError: string | null;
  readonly stateError: string | null;
  readonly labelError: string | null;
  readonly onStep: (index: number, patch: Partial<ThresholdStep>) => void;
  readonly onRemove: (index: number) => void;
}

const ThresholdRow = memo(function ThresholdRow(p: RowProps): JSX.Element {
  const [text, setText] = useState(() => textOf(p.step.value));
  // The value this row last stored or saw. Another value from outside (a reset, an undo) re-seeds
  // the text unless the text already reads as it ("adjust state during render").
  const [seen, setSeen] = useState(p.step.value);
  if (!Object.is(seen, p.step.value)) {
    setSeen(p.step.value);
    if (Number(text) !== p.step.value) setText(textOf(p.step.value));
  }
  const parsed = parse(text);
  const local = Number.isNaN(parsed)
    ? t('editor.threshold.valueInvalid')
    : inThresholdRange(parsed)
      ? null
      : fieldMessage('board.thresholds.value.range');
  const n = p.index + 1;
  return (
    <div className={cx(styles['thresholdRow'])} data-threshold-row={n}>
      <TextField
        label={t('editor.threshold.value')}
        value={text}
        inputMode="decimal"
        autoComplete="off"
        isReadOnly={p.readOnly}
        error={local ?? p.valueError}
        onChange={(next) => {
          setText(next);
          const v = parse(next);
          setSeen(v);
          p.onStep(p.index, { value: v });
        }}
      />
      <Select
        label={t('editor.threshold.state')}
        value={p.step.state}
        options={STATES.map((s) => ({ id: s.id, label: t(s.label) }))}
        onChange={(state) => {
          p.onStep(p.index, { state });
        }}
        error={p.stateError}
        isDisabled={p.readOnly}
      />
      <TextField
        label={t('editor.threshold.label')}
        value={p.step.label}
        placeholder={displayText(
          { direction: p.direction, steps: [] },
          { ...p.step, label: '' },
          p.unit,
        )}
        autoComplete="off"
        isReadOnly={p.readOnly}
        error={p.labelError}
        onChange={(label) => {
          p.onStep(p.index, { label });
        }}
      />
      <IconButton
        icon="x"
        aria-label={t('editor.threshold.remove', { n })}
        isDisabled={p.readOnly}
        onPress={() => {
          p.onRemove(p.index);
        }}
      />
    </div>
  );
});

/** The finite step values, or [0] when there is none. */
function finiteValues(steps: readonly ThresholdStep[]): number[] {
  const vs = steps.map((s) => s.value).filter((v) => Number.isFinite(v));
  return vs.length === 0 ? [0] : vs;
}

export function ThresholdsField(p: ThresholdsFieldProps): JSX.Element {
  // The latest props, so the row callbacks stay the same across renders (memoised rows).
  const latest = useRef(p);
  useLayoutEffect(() => {
    latest.current = p;
  });
  const onStep = useCallback((index: number, patch: Partial<ThresholdStep>) => {
    const v = latest.current.value;
    if (v === undefined) return;
    latest.current.onChange({
      ...v,
      steps: v.steps.map((s, k) => (k === index ? { ...s, ...patch } : s)),
    });
  }, []);
  const onRemove = useCallback((index: number) => {
    const v = latest.current.value;
    if (v === undefined) return;
    const steps = v.steps.filter((_, k) => k !== index);
    latest.current.onChange(steps.length === 0 ? undefined : { ...v, steps });
  }, []);
  const v = p.value;
  const steps = v?.steps ?? [];
  const shown = useRevealedRows(steps.length);
  const full = steps.length >= MAX_THRESHOLD_STEPS;
  const add = (): void => {
    if (v === undefined) {
      p.onChange({ direction: 'above', steps: [{ value: 0, state: 'degraded', label: '' }] });
      return;
    }
    const vs = finiteValues(v.steps);
    const value = v.direction === 'above' ? Math.max(...vs) + 1 : Math.min(...vs) - 1;
    p.onChange({ ...v, steps: [...v.steps, { value, state: 'degraded', label: '' }] });
  };
  const stepsError = p.errorAt('/steps');
  return (
    <fieldset className={cx(styles['thresholds'])} data-thresholds="">
      <legend className={cx(styles['thresholdsTitle'])}>{t('editor.thresholds')}</legend>
      {v !== undefined && (
        <Select
          label={t('editor.threshold.direction')}
          value={v.direction}
          options={[
            { id: 'above', label: t('editor.threshold.above') },
            { id: 'below', label: t('editor.threshold.below') },
          ]}
          onChange={(direction) => {
            p.onChange({ ...v, direction });
          }}
          error={p.errorAt('/direction')}
          isDisabled={p.readOnly}
        />
      )}
      {steps.slice(0, shown).map((s, k) => (
        <ThresholdRow
          // By index: the value is what a row edits, so it cannot be the key.
          key={k}
          index={k}
          step={s}
          direction={v?.direction ?? 'above'}
          unit={p.unit}
          readOnly={p.readOnly}
          valueError={p.errorAt(`/steps/${String(k)}/value`)}
          stateError={p.errorAt(`/steps/${String(k)}/state`)}
          labelError={p.errorAt(`/steps/${String(k)}/label`)}
          onStep={onStep}
          onRemove={onRemove}
        />
      ))}
      {stepsError !== null && <p className={cx(styles['thresholdsError'])}>{stepsError}</p>}
      <div className={cx(styles['thresholdsActions'])}>
        <Button onPress={add} isDisabled={p.readOnly || full}>
          {t('editor.threshold.add')}
        </Button>
        {full && (
          <p className={cx(styles['thresholdsNote'])}>
            {t('editor.threshold.full', { n: MAX_THRESHOLD_STEPS })}
          </p>
        )}
      </div>
    </fieldset>
  );
}
