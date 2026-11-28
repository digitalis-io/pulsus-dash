/** `unit:legend-format-field` (#204; T08-007, T08-008): the panel editor's Legend name field. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { DataPanelSpec } from '../../api/types';
import { LegendFormatField } from './LegendFormatField';

type Vis = DataPanelSpec['vis'];

/** A stateful caller: every `onVis` is recorded and applied. */
function mount(o: { vis?: Vis; labels?: readonly string[]; error?: string | null } = {}) {
  const calls: Vis[] = [];
  function Caller() {
    const [vis, setVis] = useState<Vis>(o.vis ?? { kind: 'line' });
    return (
      <LegendFormatField
        vis={vis}
        labels={o.labels ?? []}
        error={o.error ?? null}
        readOnly={false}
        onVis={(next) => {
          calls.push(next);
          setVis(next);
        }}
      />
    );
  }
  render(<Caller />);
  return { calls, user: userEvent.setup() };
}

const field = (): HTMLElement => screen.getByRole('textbox', { name: 'Legend name' });

describe('unit:legend-format-field', () => {
  it('sets the template as typed, and removes the key when cleared', async () => {
    const { calls, user } = mount({ vis: { kind: 'line', unit: { id: 'bytes' } } });
    expect(field()).toHaveValue('');
    expect(field()).toHaveAttribute('placeholder', '{{instance}}');
    await user.click(field());
    await user.paste('{{instance}} select');
    expect(calls.at(-1)).toEqual({
      kind: 'line',
      unit: { id: 'bytes' },
      legendFormat: '{{instance}} select',
    });
    await user.clear(field());
    expect(calls.at(-1)).toEqual({ kind: 'line', unit: { id: 'bytes' } });
    expect(calls.at(-1)).not.toHaveProperty('legendFormat');
  });

  it('shows the stored template', () => {
    mount({ vis: { kind: 'bars', legendFormat: '{{job}}' } });
    expect(field()).toHaveValue('{{job}}');
  });

  it("the hint lists the result's labels, and describes the field", () => {
    mount({ labels: ['instance', 'job'] });
    const hint = screen.getByText('Labels: instance, job');
    expect(field().getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
  });

  it('without a result the hint says how to use a label', () => {
    mount();
    expect(screen.getByText("{{label}} shows a label's value")).toBeInTheDocument();
  });

  it('shows the error', () => {
    mount({ vis: { kind: 'line', legendFormat: 'x' }, error: 'Use 1 to 256 characters.' });
    expect(screen.getByText('Use 1 to 256 characters.')).toBeInTheDocument();
  });
});
