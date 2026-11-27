/**
 * The board toolbar (plan #61 Part B §4.4), under the page header and right-aligned. View: the
 * time since the last refresh, Share and Edit board. Edit: Add panel, Add widget (plan #198 Part 3a
 * §4.4), Add section (Part C), Tags (plan #216 Part 2b §4.2), Save current time range, Discard, Save
 * and Done. In Edit mode the toolbar is a tray (`data-mode`, #282 Part 2a §4.3).
 */
import { useEffect, useState } from 'react';
import { formatHourMinute } from '../../i18n/format';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { Checkbox } from '../../kit/Checkbox';
import { cx } from '../../kit/cx';
import { Icon } from '../../kit/Icon';
import { useClock, useTimeContext } from '../../state/useTimeContext';
import type { WidgetDef } from '../../widgets/registry';
import { AddWidgetMenu } from './AddWidgetMenu';
import styles from './Board.module.css';
import { BoardShare } from './BoardShare';
import { BoardTagsButton } from './BoardTagsButton';

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
  | { mode: 'view'; onEdit: () => void }
  | {
      mode: 'edit';
      /** A save or Discard's reload is in flight: every edit control is disabled. */
      busy: boolean;
      dirty: boolean;
      savesTime: boolean;
      onAdd: () => void;
      /** A widget kind from Add widget. */
      onAddWidget: (def: WidgetDef) => void;
      onAddSection: () => void;
      /** The draft's tags. */
      tags: readonly string[];
      /** A save's error at `/tags` (its text), else null. */
      tagsError: string | null;
      onTags: (tags: readonly string[]) => void;
      onSaveTime: (on: boolean) => void;
      onDiscard: () => void;
      onSave: () => void;
      onDone: () => void;
    };

export function BoardToolbar(props: BoardToolbarProps) {
  if (props.mode === 'view') {
    return (
      <div
        role="group"
        aria-label={t('board.actions')}
        className={cx(styles['toolbar'])}
        data-mode="view"
      >
        <Updated />
        <BoardShare />
        <Button variant="primary" onPress={props.onEdit}>
          {t('board.edit')}
        </Button>
      </div>
    );
  }
  const { busy, dirty } = props;
  return (
    <div
      role="group"
      aria-label={t('board.actions')}
      className={cx(styles['toolbar'])}
      data-mode="edit"
    >
      <Button onPress={props.onAdd} isDisabled={busy} data-board-add="">
        <Icon name="plus" />
        {t('board.addPanel')}
      </Button>
      <AddWidgetMenu label={t('board.addWidget')} busy={busy} onAdd={props.onAddWidget} />
      <Button onPress={props.onAddSection} isDisabled={busy}>
        <Icon name="plus" />
        {t('board.addSection')}
      </Button>
      <BoardTagsButton
        tags={props.tags}
        error={props.tagsError}
        busy={busy}
        onChange={props.onTags}
      />
      <Checkbox isSelected={props.savesTime} onChange={props.onSaveTime} isDisabled={busy}>
        {t('board.saveTime')}
      </Checkbox>
      <Button onPress={props.onDiscard} isDisabled={busy || !dirty}>
        {t('board.discard')}
      </Button>
      <Button variant="primary" onPress={props.onSave} isDisabled={busy || !dirty}>
        {t('board.save')}
      </Button>
      <Button onPress={props.onDone} isDisabled={busy}>
        {t('board.done')}
      </Button>
    </div>
  );
}
