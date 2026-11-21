/**
 * The board toolbar (plan #61 Part B §4.4), under the page header and right-aligned. View: the
 * time since the last refresh, Share and Edit board. Edit: Add panel, Save current time range,
 * Discard, Save and Done.
 */
import { useEffect, useState } from 'react';
import { formatHourMinute } from '../../i18n/format';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { Checkbox } from '../../kit/Checkbox';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import { useClock, useTimeContext } from '../../state/useTimeContext';
import styles from './Board.module.css';
import { BoardShare } from './BoardShare';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** `Updated 5 s ago`, `Updated 3 min ago`, else `Updated at 14:05` in the zone. */
export function updatedText(nowMs: number, anchorMs: number, timeZone: string): string {
  const ago = Math.max(0, nowMs - anchorMs);
  if (ago < MINUTE) return t('board.updatedSeconds', { n: Math.floor(ago / SECOND) });
  if (ago < HOUR) return t('board.updatedMinutes', { n: Math.floor(ago / MINUTE) });
  return t('board.updatedAt', { time: formatHourMinute(anchorMs, timeZone) });
}

/** The time since the Context's anchor, re-rendered every second. */
function Updated() {
  const clock = useClock();
  const { anchorMs, timeZone } = useTimeContext();
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    const id = setInterval(() => {
      setNow(clock.now());
    }, SECOND);
    return () => {
      clearInterval(id);
    };
  }, [clock]);
  return (
    <span className={cx(styles['updated'])}>
      {updatedText(Math.max(now, anchorMs), anchorMs, timeZone)}
    </span>
  );
}

export type BoardToolbarProps =
  | { mode: 'view'; onEdit: () => void; onPreloadEdit: () => void }
  | {
      mode: 'edit';
      saving: boolean;
      dirty: boolean;
      savesTime: boolean;
      onAdd: () => void;
      onSaveTime: (on: boolean) => void;
      onDiscard: () => void;
      onSave: () => void;
      onDone: () => void;
    };

export function BoardToolbar(props: BoardToolbarProps) {
  if (props.mode === 'view') {
    return (
      <div role="group" aria-label={t('board.actions')} className={cx(styles['toolbar'])}>
        <Updated />
        <BoardShare />
        <Button
          variant="primary"
          onPress={props.onEdit}
          onHoverStart={props.onPreloadEdit}
          onFocus={props.onPreloadEdit}
        >
          {t('board.edit')}
        </Button>
      </div>
    );
  }
  const { saving, dirty } = props;
  return (
    <div role="group" aria-label={t('board.actions')} className={cx(styles['toolbar'])}>
      <Button onPress={props.onAdd} isDisabled={saving}>
        <Icon name="plus" />
        {t('board.addPanel')}
      </Button>
      <Checkbox isSelected={props.savesTime} onChange={props.onSaveTime} isDisabled={saving}>
        {t('board.saveTime')}
      </Checkbox>
      <Button onPress={props.onDiscard} isDisabled={saving || !dirty}>
        {t('board.discard')}
      </Button>
      <Button variant="primary" onPress={props.onSave} isDisabled={saving || !dirty}>
        {t('board.save')}
      </Button>
      <Button onPress={props.onDone} isDisabled={saving}>
        {t('board.done')}
      </Button>
    </div>
  );
}
