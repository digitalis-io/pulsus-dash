/**
 * The metric picker of the Explore query card (plan #63 Part C §3.3; SRF-031 subset): a combo box
 * over the metric names, each with its type and help, that opens on focus. Names are asked once the
 * list first opens (`['prom', tenant, 'pickerNames']`) and filtered locally, at most
 * `PICKER_OPTIONS` shown. Choosing a name hands it to `onPick` and clears the input; Enter with no
 * option highlighted picks the first match.
 */
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState, type JSX, type KeyboardEvent } from 'react';
import { ComboBox, Input, ListBox, ListBoxItem, Text, type Key } from 'react-aria-components';
import type { PromMetadata } from '../../data/decode';
import { metricOptions, PICKER_OPTIONS } from '../../explore/metricOptions';
import { t } from '../../i18n/t';
import { cx } from '../../kit/cx';
import { Popover } from '../../kit/Popover';
import styles from './Explore.module.css';

export interface MetricPickerProps {
  readonly tenant: string;
  /** The editor's `source.metricNames`, once the editor chunk has loaded. */
  readonly names: (() => Promise<readonly string[]>) | null;
  readonly meta: PromMetadata['metrics'];
  readonly onPick: (name: string) => void;
}

const NO_NAMES: readonly string[] = [];
export const PICKER_NAMES_STALE_MS = 60_000;

export function MetricPicker({ tenant, names, meta, onPick }: MetricPickerProps): JSX.Element {
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState(false);
  const list = useQuery({
    queryKey: ['prom', tenant, 'pickerNames'],
    queryFn: () => (names === null ? Promise.resolve(NO_NAMES) : names()),
    staleTime: PICKER_NAMES_STALE_MS,
    enabled: opened && names !== null,
  });
  const all = list.data ?? NO_NAMES;
  const { options, total } = useMemo(() => metricOptions(all, meta, filter), [all, meta, filter]);

  const pick = (name: string): void => {
    setFilter('');
    onPick(name);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    const first = options[0];
    if (e.key !== 'Enter' || first === undefined) return;
    if (e.currentTarget.getAttribute('aria-activedescendant')) return;
    e.preventDefault();
    pick(first.name);
  };

  return (
    <ComboBox
      aria-label={t('explore.picker.label')}
      menuTrigger="focus"
      allowsEmptyCollection
      isDisabled={names === null}
      items={options}
      inputValue={filter}
      onInputChange={setFilter}
      value={null}
      onChange={(k: Key | null) => {
        if (k !== null) pick(String(k));
      }}
      onOpenChange={(open) => {
        if (open) setOpened(true);
      }}
      className={cx(styles['picker'])}
    >
      <Input
        className={cx(styles['pickerInput'])}
        placeholder={t('explore.picker.placeholder')}
        onKeyDown={onKeyDown}
      />
      <Popover className={cx(styles['pickerPopover'])} placement="bottom start">
        <ListBox
          renderEmptyState={() => (
            <p className={cx(styles['pickerNote'])}>{t('explore.picker.none')}</p>
          )}
        >
          {(o: { name: string; description: string }) => (
            <ListBoxItem id={o.name} textValue={o.name} className={cx(styles['option'])}>
              <span className={cx(styles['optionName'])}>{o.name}</span>
              {o.description !== '' && (
                <Text slot="description" className={cx(styles['optionDescription'])}>
                  {o.description}
                </Text>
              )}
            </ListBoxItem>
          )}
        </ListBox>
        {total > PICKER_OPTIONS && (
          <p className={cx(styles['pickerNote'])}>
            {t('explore.picker.more', { shown: PICKER_OPTIONS, total })}
          </p>
        )}
      </Popover>
    </ComboBox>
  );
}
