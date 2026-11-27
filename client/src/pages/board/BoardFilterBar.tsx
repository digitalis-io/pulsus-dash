/**
 * The toolbar's left side (plan #61 Part C §4.3, Appendix C-A §A.9; SRF-017 subset): a chip per
 * variable the board's queries reference, a chip per `label=value` filter and `+ Filter`. Values
 * live in the board URL only (`useBoardParams`), so they are never saved, Copy link carries them
 * and Back undoes them. No panel query reads them yet (#64).
 */
import { useState } from 'react';
import { DialogTrigger, Heading } from 'react-aria-components';
import { t } from '../../i18n/t';
import { Button } from '../../kit/Button';
import { cx } from '../../kit/cx';
import { Dialog } from '../../kit/Dialog';
import { Icon } from '../../kit/Icon';
import { Popover } from '../../kit/Popover';
import { TextField } from '../../kit/TextField';
import {
  checkFilterKey,
  checkParamValue,
  MAX_FILTERS,
  type ParamError,
} from '../../state/boardParams';
import type { BoardParamsState } from '../../state/useBoardParams';
import styles from './Board.module.css';

const message = (e: ParamError | null): string | null => (e === null ? null : t(e));

function submitted(e: { preventDefault: () => void }, f: () => void): void {
  e.preventDefault();
  f();
}

function Chip({ name, value, label }: { name: string; value: string; label: string }) {
  return (
    <Button variant="ghost" aria-label={label} className={cx(styles['chip'])}>
      <span className={cx(styles['chipKey'])}>{name}</span>{' '}
      <span className={cx(styles['chipValue'])}>{value}</span>
      <Icon name="chevron-down" />
    </Button>
  );
}

/** The Value form of a variable or a filter: Apply (submit) and a second action. */
function ValueForm({
  title,
  initial,
  secondary,
  apply,
  onSecondary,
  close,
}: {
  title: string;
  initial: string;
  secondary: string;
  apply: (value: string) => ParamError | null;
  onSecondary: () => void;
  close: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState<ParamError | null>(null);
  return (
    <form
      className={cx(styles['filterDialog'])}
      onSubmit={(e) => {
        submitted(e, () => {
          const r = apply(value);
          setError(r);
          if (r === null) close();
        });
      }}
    >
      <Heading slot="title" className={cx(styles['shareTitle'])}>
        {title}
      </Heading>
      <TextField
        label={t('filters.value')}
        value={value}
        onChange={(v) => {
          setValue(v);
          setError(null);
        }}
        error={message(error)}
        autoFocus
      />
      <div className={cx(styles['dialogActions'])}>
        <Button type="submit" variant="primary">
          {t('filters.apply')}
        </Button>
        <Button
          onPress={() => {
            onSecondary();
            close();
          }}
        >
          {secondary}
        </Button>
      </div>
    </form>
  );
}

function AddFilterForm({ state, close }: { state: BoardParamsState; close: () => void }) {
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  const [labelError, setLabelError] = useState<ParamError | null>(null);
  const [valueError, setValueError] = useState<ParamError | null>(null);
  /** The first failing check shows under its field (Appendix C-A §A.9); the URL is unchanged. */
  const add = (): void => {
    const key = label.trim();
    const { filters } = state.params;
    const show = (onLabel: ParamError | null, onValue: ParamError | null): void => {
      setLabelError(onLabel);
      setValueError(onValue);
    };
    const keyErr = checkFilterKey(key);
    const valErr = keyErr === null ? checkParamValue(value) : null;
    const full = !filters.some((f) => f.key === key) && filters.length >= MAX_FILTERS;
    if (keyErr !== null || valErr !== null || full) {
      show(keyErr ?? (valErr === null ? 'filter.tooMany' : null), valErr);
      return;
    }
    const r = state.setFilter(key, value.trim());
    show(null, r);
    if (r === null) close();
  };
  return (
    <form
      className={cx(styles['filterDialog'])}
      onSubmit={(e) => {
        submitted(e, add);
      }}
    >
      <Heading slot="title" className={cx(styles['shareTitle'])}>
        {t('filters.addTitle')}
      </Heading>
      <TextField
        label={t('filters.label')}
        value={label}
        onChange={(v) => {
          setLabel(v);
          setLabelError(null);
        }}
        error={message(labelError)}
        autoFocus
      />
      <TextField
        label={t('filters.value')}
        value={value}
        onChange={(v) => {
          setValue(v);
          setValueError(null);
        }}
        error={message(valueError)}
      />
      <div className={cx(styles['dialogActions'])}>
        <Button type="submit" variant="primary">
          {t('filters.addSubmit')}
        </Button>
        <Button onPress={close}>{t('filters.cancel')}</Button>
      </div>
    </form>
  );
}

export function BoardFilterBar({
  variables,
  state,
}: {
  /** The board's variables, in first-reference order (`boardVariables(draft)`). */
  variables: readonly string[];
  state: BoardParamsState;
}) {
  const { vars, filters } = state.params;
  return (
    <div role="group" aria-label={t('filters.group')} className={cx(styles['filterBar'])}>
      {variables.map((name) => {
        const current = vars.get(name);
        const shown = current ?? t('filters.notSet');
        const title = t('filters.variableTitle', { name });
        return (
          <DialogTrigger key={`var-${name}`}>
            <Chip name={name} value={shown} label={t('filters.variable', { name, value: shown })} />
            <Popover placement="bottom start">
              <Dialog aria-label={title}>
                {({ close }) => (
                  <ValueForm
                    title={title}
                    initial={current ?? ''}
                    secondary={t('filters.clear')}
                    apply={(v) => {
                      const trimmed = v.trim();
                      if (trimmed === '') return state.setVar(name, null);
                      return checkParamValue(v) ?? state.setVar(name, trimmed);
                    }}
                    onSecondary={() => {
                      state.setVar(name, null);
                    }}
                    close={close}
                  />
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
        );
      })}
      {filters.map((f) => {
        const title = t('filters.filterTitle', { key: f.key });
        return (
          <DialogTrigger key={`f-${f.key}`}>
            <Chip
              name={f.key}
              value={f.value}
              label={t('filters.filter', { key: f.key, value: f.value })}
            />
            <Popover placement="bottom start">
              <Dialog aria-label={title}>
                {({ close }) => (
                  <ValueForm
                    title={title}
                    initial={f.value}
                    secondary={t('filters.remove')}
                    apply={(v) => checkParamValue(v) ?? state.setFilter(f.key, v.trim())}
                    onSecondary={() => {
                      state.setFilter(f.key, null);
                    }}
                    close={close}
                  />
                )}
              </Dialog>
            </Popover>
          </DialogTrigger>
        );
      })}
      <DialogTrigger>
        <Button variant="ghost" className={cx(styles['chip'], styles['addFilter'])}>
          <Icon name="plus" />
          {t('filters.add')}
        </Button>
        <Popover placement="bottom start">
          <Dialog aria-label={t('filters.addTitle')}>
            {({ close }) => <AddFilterForm state={state} close={close} />}
          </Dialog>
        </Popover>
      </DialogTrigger>
    </div>
  );
}
