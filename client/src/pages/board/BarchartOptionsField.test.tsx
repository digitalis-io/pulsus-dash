/** `unit:barchart-options-field` (plan #173 Part 3a §3.9; T22 §6.1). */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { VisOptions } from '../../api/types';
import type { OptionKey } from '../../boards/options';
import { BarchartOptionsField } from './BarchartOptionsField';

/** A stateful caller: every `onChange` is recorded and applied. */
function mount(o: { options?: VisOptions; errorAt?: (k: OptionKey) => string | null } = {}) {
  const calls: (VisOptions | undefined)[] = [];
  function Caller() {
    const [options, setOptions] = useState<VisOptions | undefined>(o.options);
    return (
      <BarchartOptionsField
        options={options}
        errorAt={o.errorAt ?? (() => null)}
        readOnly={false}
        onChange={(next) => {
          calls.push(next);
          setOptions(next);
        }}
      />
    );
  }
  render(<Caller />);
  return { calls, user: userEvent.setup() };
}

const trigger = (label: string): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`${label}$`) });

describe('unit:barchart-options-field', () => {
  it('shows the T22 §6.1 defaults', () => {
    mount();
    expect(trigger('Reducer')).toHaveTextContent('Last');
    expect(screen.getByRole('textbox', { name: 'Category label' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Category label' })).toHaveAttribute(
      'placeholder',
      'Automatic',
    );
    expect(trigger('Sort')).toHaveTextContent('Value, descending');
    const orientation = screen.getByRole('radiogroup', { name: 'Orientation' });
    expect(within(orientation).getByRole('radio', { name: 'Horizontal' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Value labels' })).toBeChecked();
    expect(screen.getByRole('textbox', { name: 'Min' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Max' })).toHaveValue('');
    expect(trigger('Baseline')).toHaveTextContent('None');
  });

  it('each field writes its key; empty removes it; all empty is undefined', async () => {
    const { calls, user } = mount();
    await user.click(trigger('Reducer'));
    await user.click(await screen.findByRole('option', { name: 'Sum' }));
    expect(calls.at(-1)).toEqual({ reducer: 'sum' });
    await user.click(trigger('Reducer'));
    await user.click(await screen.findByRole('option', { name: 'Last' }));

    const label = screen.getByRole('textbox', { name: 'Category label' });
    await user.type(label, ' version ');
    expect(calls.at(-1)).toEqual({ reducer: 'last', categoryBy: 'version' });
    await user.clear(label);
    expect(calls.at(-1)).toEqual({ reducer: 'last' });
  });

  it('min and max: a finite number writes, an empty field removes, text shows an error', async () => {
    const { calls, user } = mount();
    await user.type(screen.getByRole('textbox', { name: 'Min' }), '0');
    await user.type(screen.getByRole('textbox', { name: 'Max' }), '500');
    expect(calls.at(-1)).toEqual({ min: 0, max: 500 });
    const n = calls.length;
    const max = screen.getByRole('textbox', { name: 'Max' });
    await user.clear(max);
    expect(calls.at(-1)).toEqual({ min: 0 });
    await user.type(max, 'abc');
    expect(screen.getByText('Enter a number')).toBeInTheDocument();
    expect(calls).toHaveLength(n + 1);
  });

  it('baseline: 1 d writes, None removes; errorAt shows under its field', async () => {
    const errorAt = vi.fn((k: OptionKey) => (k === 'max' ? 'Max must be above min' : null));
    const { calls, user } = mount({ errorAt });
    expect(screen.getByText('Max must be above min')).toBeInTheDocument();
    await user.click(trigger('Baseline'));
    await user.click(await screen.findByRole('option', { name: '1 d' }));
    expect(calls.at(-1)).toEqual({ baselineOffset: '1d' });
    await user.click(trigger('Baseline'));
    await user.click(await screen.findByRole('option', { name: 'None' }));
    expect(calls.at(-1)).toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});
