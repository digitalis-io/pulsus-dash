/**
 * The board's tag field (plan #216 Part 2b §4.2; T24-029, T08-007), in the Tags popover: the tags
 * as chips, each with its × (`Remove tag ‹tag›`), then the "Add a tag" input and its help. Return,
 * or a newly typed or pasted comma or white space, adds what was typed through `addTags`,
 * lower-cased; a piece that cannot be added stays in the input (with any later pieces) and its
 * text, which clears on typing; editing that kept text commits nothing until the next separator or
 * Return. Backspace in
 * an empty input removes the last tag; a chip's × moves focus to the next ×, else the input. At 16
 * tags the input is disabled and its help says why. A save's error (`error`) shows under the chips.
 */
import { useEffect, useId, useRef, useState, type ReactElement } from 'react';
import { fieldMessage } from '../../boards/fieldMessages';
import { MAX_BOARD_TAGS } from '../../boards/spec';
import { addTags, type TagProblem } from '../../boards/tags';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { IconButton } from '../../kit/IconButton';
import { TextField } from '../../kit/TextField';
import styles from './Board.module.css';

const SEPARATORS = /[\s,]/gu;

/** The number of commas and white-space characters in `text`. */
function separators(text: string): number {
  return text.match(SEPARATORS)?.length ?? 0;
}

function problemText(p: TagProblem): string {
  if (p === 'full') return t('board.tags.full');
  return fieldMessage(p === 'invalid' ? 'board.tags.invalid' : 'board.tags.duplicate');
}

export interface BoardTagsFieldProps {
  tags: readonly string[];
  /** A save's error at `/tags` (its text), else null. */
  error: string | null;
  readOnly: boolean;
  onChange: (tags: readonly string[]) => void;
}

export function BoardTagsField({
  tags,
  error,
  readOnly,
  onChange,
}: BoardTagsFieldProps): ReactElement {
  const [input, setInput] = useState('');
  const [problem, setProblem] = useState<TagProblem | null>(null);
  // After a removal: the index of the × to focus once the chips have rendered (else the input).
  const focusAt = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const full = tags.length >= MAX_BOARD_TAGS;

  useEffect(() => {
    const at = focusAt.current;
    if (at === null) return;
    focusAt.current = null;
    const next = rootRef.current?.querySelectorAll<HTMLElement>('[data-tag-remove]')[at];
    if (next !== undefined) next.focus();
    else inputRef.current?.focus();
  }, [tags]);

  const add = (text: string): void => {
    const r = addTags(tags, text);
    if (r.tags !== tags) onChange(r.tags);
    setInput(r.rest);
    setProblem(r.problem);
  };
  const remove = (i: number): void => {
    focusAt.current = i;
    onChange(tags.filter((_, j) => j !== i));
  };

  return (
    <div ref={rootRef} className={cx(styles['tagsField'])}>
      {tags.length === 0 ? (
        <p className={cx(styles['tagsNone'])}>{t('board.tags.none')}</p>
      ) : (
        <ul className={cx(styles['tagChips'])} aria-label={t('board.tags')}>
          {tags.map((tag, i) => (
            <li key={tag} className={cx(styles['tagItem'])}>
              <span className={cx(styles['tagChip'])}>{tag}</span>
              <IconButton
                icon="x"
                aria-label={t('board.tags.remove', { tag })}
                isDisabled={readOnly}
                data-tag-remove=""
                onPress={() => {
                  remove(i);
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {error !== null && <p className={cx(styles['tagsError'])}>{error}</p>}
      <TextField
        label={t('board.tags.add')}
        value={input}
        inputRef={inputRef}
        mono
        autoComplete="off"
        isDisabled={full || readOnly}
        aria-describedby={helpId}
        error={problem === null ? null : problemText(problem)}
        onChange={(v) => {
          // A newly typed or pasted comma or white space adds what precedes it; separators kept
          // in the input after a failed run do not, so correcting it commits nothing early.
          if (separators(v) > separators(input)) add(v);
          else {
            setInput(v);
            setProblem(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add(input);
            return;
          }
          if (e.key === 'Backspace' && input === '' && tags.length > 0) {
            e.preventDefault();
            onChange(tags.slice(0, -1));
            return;
          }
          e.continuePropagation();
        }}
      />
      <p id={helpId} className={cx(styles['tagsHelp'])}>
        {full ? t('board.tags.full') : t('board.tags.help')}
      </p>
    </div>
  );
}
