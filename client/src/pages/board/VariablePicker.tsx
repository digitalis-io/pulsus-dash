/**
 * A board variable's chip and picker (plan #289 §4.4, SRF-017, T08-007): the chip, a 28 px field
 * capsule, shows the variable's state; its popover is a search over the values (React Aria
 * `Autocomplete`, `SearchField` and the kit `ListBox`) with single or multiple selection, All,
 * the selected values not in the list tagged "custom", and Reset. A single-select choice commits
 * and closes; a multi-select draft commits on Apply or ⌘/Ctrl+Enter and is discarded on Escape.
 * Every write is the variable's encoded address values (`encodeValue`); a write over the URL
 * budget is refused and shown.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import {
  Autocomplete,
  DialogTrigger,
  Input,
  SearchField,
  type Key,
  type Selection as AriaSelection,
} from 'react-aria-components';
import type { BoardVariable } from '../../api/types';
import {
  MAX_SELECTION_BYTES,
  MAX_SELECTION_VALUES,
  selectionBytes,
  type Selection,
  type VariableList,
  type VarState,
} from '../../boards/resolveVariables';
import { t } from '../../i18n/t';
import { usePoliteAnnouncer } from '../../kit/announce';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Dialog } from '../../kit/Dialog';
import { Icon } from '../../kit/Icon';
import { ListBox, ListBoxItem } from '../../kit/ListBox';
import { Popover } from '../../kit/Popover';
import { ALL_TOKEN, encodeValue, type ParamError } from '../../state/boardParams';
import { StateEncoding } from '../../theme/stateEncoding';
import styles from './VariablePicker.module.css';

export interface VariablePickerProps {
  readonly def: BoardVariable;
  readonly state: VarState;
  /** The variable's value list, sorted; undefined until a query variable can fetch it. */
  readonly list: VariableList | undefined;
  /** The label of a variable by name (the waiting chip names the one it waits for). */
  readonly labelOf: (name: string) => string;
  /** Writes the encoded address values; null removes them (Reset to default). */
  readonly onCommit: (encoded: readonly string[] | null) => ParamError | null;
  readonly onRetry: () => void;
}

/** At most this many listed matches are rows; the rest are a count. */
const MAX_ROWS = 200;
const ALL_ID = '\u0000all';
const USE_ID = '\u0000use';
const valueId = (v: string): string => `v\u0000${v}`;
const idValue = (id: Key): string | null => {
  const s = String(id);
  return s.startsWith('v\u0000') ? s.slice(2) : null;
};

/** The chip's value text for `state`. */
function chipText(state: VarState, labelOf: (name: string) => string): string {
  switch (state.kind) {
    case 'ready':
      return state.display;
    case 'loading':
      return t('panel.loading');
    case 'waiting':
      return t('variables.waiting', { label: labelOf(state.on) });
    case 'failed':
      return t('variables.unavailable');
    case 'tooMany':
      return t('variables.tooMany');
    case 'unset':
      return t('filters.notSet');
  }
}

const selectionOf = (state: VarState): Selection | null =>
  state.kind === 'ready' || state.kind === 'tooMany' ? state.selection : null;

/** The encoded address values of a draft. */
const encoded = (all: boolean, values: readonly string[]): string[] =>
  all ? [ALL_TOKEN] : values.map(encodeValue);

function PickerBody({
  def,
  state,
  list,
  onCommit,
  onRetry,
  close,
}: Omit<VariablePickerProps, 'labelOf'> & { close: () => void }) {
  const label = def.label === '' ? def.name : def.label;
  const multi = def.multi === true;
  const includeAll = def.includeAll === true;
  const initial = selectionOf(state);
  const [draftAll, setDraftAll] = useState(initial !== null && 'all' in initial);
  const [draft, setDraft] = useState<readonly string[]>(
    initial !== null && 'values' in initial ? initial.values : [],
  );
  const [search, setSearch] = useState('');
  const [error, setError] = useState<ParamError | null>(null);
  const announcer = usePoliteAnnouncer();

  const listed = useMemo(() => (list?.status === 'ready' ? list.values : []), [list]);
  // Custom rows: the selected values the list does not hold, kept while the picker is open.
  const [customs, setCustoms] = useState<readonly string[]>(() =>
    initial !== null && 'values' in initial
      ? initial.values.filter((v) => !listed.includes(v))
      : [],
  );
  const needle = search.trim().toLowerCase();
  const matches = useMemo(
    () => listed.filter((v) => needle === '' || v.toLowerCase().includes(needle)),
    [listed, needle],
  );
  const rows = matches.slice(0, MAX_ROWS);
  const more = matches.length - rows.length;
  const exact = search.trim();
  const useRow =
    exact !== '' && !listed.includes(exact) && !customs.includes(exact) && matches.length === 0;

  const status = list?.status ?? 'loading';
  useEffect(() => {
    if (status === 'loading') announcer.announce(t('variables.loading'));
    else if (status === 'failed') announcer.announce(t('variables.unavailable'));
  }, [status, announcer]);
  useEffect(() => {
    if (status === 'ready' && needle !== '') {
      announcer.announce(t('variables.matches', { n: String(matches.length) }));
    }
  }, [status, needle, matches.length, announcer]);

  const commit = (values: readonly string[] | null): void => {
    const r = onCommit(values);
    setError(r);
    if (r === null) close();
  };
  const setDraftValues = (vs: readonly string[]): void => {
    setDraft(vs);
    setDraftAll(false);
    announcer.announce(t('variables.selected', { n: String(vs.length) }));
  };
  const chooseAll = (): void => {
    setDraftAll(true);
    setDraft([]);
    announcer.announce(t('variables.selected', { n: '1' }));
  };

  // A row is disabled when adding it would take the draft over 200 values or 65 536 bytes; the
  // draft's bytes are counted once, each row's own bytes added to them.
  const draftBytes = useMemo(() => selectionBytes(draft), [draft]);
  const blocked = (v: string): boolean =>
    multi &&
    !draftAll &&
    !draft.includes(v) &&
    (draft.length + 1 > MAX_SELECTION_VALUES ||
      draftBytes + selectionBytes([v]) - 2 + (draft.length > 0 ? 1 : 0) > MAX_SELECTION_BYTES);
  const shown = [...customs, ...rows.filter((v) => !customs.includes(v))];
  const anyBlocked = multi && !draftAll && [...customs, ...listed].some(blocked);
  const disabledKeys = shown.filter(blocked).map(valueId);

  const selectedKeys = draftAll ? [ALL_ID] : draft.map(valueId);
  const onSelectionChange = (keys: AriaSelection): void => {
    if (keys === 'all') return;
    const next = new Set([...keys].map(String));
    const before = new Set(selectedKeys);
    const added = [...next].filter((k) => !before.has(k));
    if (added.includes(ALL_ID)) {
      chooseAll();
      return;
    }
    if (added.includes(USE_ID)) {
      if (!customs.includes(exact)) setCustoms([...customs, exact]);
      setDraftValues([...draft, exact]);
      return;
    }
    const kept = draft.filter((v) => next.has(valueId(v)));
    const plus = added.flatMap((k) => {
      const v = idValue(k);
      return v === null ? [] : [v];
    });
    setDraftValues([...kept, ...plus]);
  };
  // Single selection: choosing a row commits it and closes.
  const onSingle = (keys: AriaSelection): void => {
    if (keys === 'all') return;
    const key = [...keys][0];
    if (key === undefined) return;
    if (key === ALL_ID) commit([ALL_TOKEN]);
    else if (key === USE_ID) commit([encodeValue(exact)]);
    else {
      const v = idValue(key);
      if (v !== null) commit([encodeValue(v)]);
    }
  };
  const canApply = draftAll || draft.length > 0;
  const apply = (): void => {
    if (canApply) commit(encoded(draftAll, draft));
  };
  // Captured before the search field and the list read the keys: ⌘/Ctrl+Enter applies; Escape
  // with an empty search discards the draft (a non-empty search is cleared first, by the field).
  const onKeyDownCapture = (e: KeyboardEvent): void => {
    if (multi && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      apply();
      return;
    }
    if (e.key === 'Escape' && search === '') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <div className={cx(styles['picker'])} onKeyDownCapture={onKeyDownCapture}>
      <Autocomplete inputValue={search} onInputChange={setSearch}>
        <SearchField aria-label={t('variables.search')} className={cx(styles['search'])} autoFocus>
          <Input className={cx(styles['input'])} placeholder={t('variables.search')} />
        </SearchField>
        <ListBox
          aria-label={t('variables.values', { label })}
          selectionMode={multi ? 'multiple' : 'single'}
          selectedKeys={selectedKeys}
          disabledKeys={disabledKeys}
          disallowEmptySelection={!multi}
          onSelectionChange={multi ? onSelectionChange : onSingle}
          className={cx(styles['list'])}
          renderEmptyState={() => (
            <p className={cx(styles['empty'])}>
              {status === 'loading'
                ? t('variables.loading')
                : status === 'failed'
                  ? t('variables.unavailable')
                  : t('variables.none')}
            </p>
          )}
        >
          {includeAll && <ListBoxItem id={ALL_ID} label={t('variables.all')} check={multi} />}
          {customs.map((v) => (
            <ListBoxItem
              key={`c${v}`}
              id={valueId(v)}
              label={v}
              tag={t('variables.customTag')}
              textValue={v}
              aria-label={t('variables.custom', { value: v })}
              check={multi}
            />
          ))}
          {rows
            .filter((v) => !customs.includes(v))
            .map((v) => (
              <ListBoxItem key={`v${v}`} id={valueId(v)} label={v} check={multi} />
            ))}
          {useRow && (
            <ListBoxItem
              id={USE_ID}
              label={t('variables.use', { text: exact })}
              note
              check={multi}
            />
          )}
        </ListBox>
      </Autocomplete>
      {more > 0 && <p className={cx(styles['note'])}>{t('variables.more', { n: String(more) })}</p>}
      {list?.status === 'ready' && list.truncated && (
        <p className={cx(styles['note'])}>{t('variables.truncated')}</p>
      )}
      {anyBlocked && <p className={cx(styles['note'])}>{t('variables.tooMany')}</p>}
      {error !== null && <p className={cx(styles['note'])}>{t(error)}</p>}
      <div className={cx(styles['footer'])}>
        {status === 'failed' && <Button onPress={onRetry}>{t('boardList.retry')}</Button>}
        <Button
          onPress={() => {
            commit(null);
          }}
        >
          {t('variables.reset')}
        </Button>
        {multi && (
          <Button variant="primary" isDisabled={!canApply} onPress={apply}>
            {t('filters.apply')}
          </Button>
        )}
      </div>
      <p role="status" className={cx(styles['live'])}>
        {announcer.text}
      </p>
    </div>
  );
}

export function VariablePicker(p: VariablePickerProps) {
  const label = p.def.label === '' ? p.def.name : p.def.label;
  const value = chipText(p.state, p.labelOf);
  const glyph = p.state.kind === 'failed' || p.state.kind === 'tooMany';
  return (
    <DialogTrigger>
      <Button
        aria-label={t('variables.chip', { label, display: value })}
        aria-haspopup="dialog"
        {...(p.state.kind === 'loading' ? { 'aria-busy': true } : {})}
        className={cx(styles['chip'], p.state.kind === 'loading' ? styles['loading'] : undefined)}
        data-variable={p.def.name}
        data-variable-state={p.state.kind}
      >
        <span className={cx(styles['chipLabel'])}>{label}</span>
        {glyph && (
          <span className={cx(StateEncoding.degraded.className)} aria-hidden="true">
            {StateEncoding.degraded.glyph}
          </span>
        )}
        <span
          className={cx(
            styles['chipValue'],
            p.state.kind === 'ready' ? undefined : styles['chipMuted'],
          )}
        >
          {value}
        </span>
        <Icon name="chevron-down" />
      </Button>
      <Popover placement="bottom start">
        <Dialog aria-label={t('variables.dialog', { label })}>
          {({ close }) => <PickerBody {...p} close={close} />}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
