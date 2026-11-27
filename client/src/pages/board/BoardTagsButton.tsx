/**
 * The Edit toolbar's Tags button (plan #216 Part 2b §4.2; T24-029), after Add section: a popover
 * dialog "Board tags" holding the tag field. The trigger's visible text is its whole name ("Tags",
 * or "Tags (2)" with two tags; no `aria-label`), its icon is hidden from assistive technology, and
 * it is disabled while a save or Discard is in flight. Esc closes the popover onto the trigger.
 */
import type { ReactElement } from 'react';
import { DialogTrigger, Heading } from 'react-aria-components';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Dialog } from '../../kit/Dialog';
import { Popover } from '../../kit/Popover';
import styles from './Board.module.css';
import { BoardTagsField } from './BoardTagsField';

export interface BoardTagsButtonProps {
  tags: readonly string[];
  /** A save's error at `/tags` (its text), else null. */
  error: string | null;
  busy: boolean;
  onChange: (tags: readonly string[]) => void;
}

export function BoardTagsButton({
  tags,
  error,
  busy,
  onChange,
}: BoardTagsButtonProps): ReactElement {
  return (
    <DialogTrigger>
      <Button isDisabled={busy} data-board-tags="">
        <span className={cx(styles['tagIcon'])} aria-hidden="true" />
        {tags.length > 0 ? t('board.tagsCount', { n: tags.length }) : t('board.tags')}
      </Button>
      <Popover placement="bottom start">
        <Dialog aria-label={t('board.tags.dialog')} className={cx(styles['tags'])}>
          <Heading slot="title" className={cx(styles['shareTitle'])}>
            {t('board.tags.dialog')}
          </Heading>
          <BoardTagsField tags={tags} error={error} readOnly={busy} onChange={onChange} />
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
