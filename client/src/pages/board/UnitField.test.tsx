/** `unit:unit-picker` (#290 §4.4; T22-015, T08-007, T08-008): the panel editor's unit field. */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import type { DataPanelSpec } from '../../api/types';
import type { VisKind } from '../../engine/api';
import { UnitField } from './UnitField';

type Vis = DataPanelSpec['vis'];

/** A stateful caller: every `onVis` is recorded and applied. */
function mount(
  o: {
    vis?: Vis;
    rateApplied?: boolean;
    drawnKind?: VisKind | null;
    errorAt?: (suffix: string) => string | null;
  } = {},
) {
  const calls: Vis[] = [];
  function Caller() {
    const [vis, setVis] = useState<Vis>(o.vis ?? { kind: 'line' });
    return (
      <UnitField
        vis={vis}
        rateApplied={o.rateApplied ?? false}
        drawnKind={o.drawnKind ?? null}
        errorAt={o.errorAt ?? (() => null)}
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

const trigger = (): HTMLElement => screen.getByRole('button', { name: /Unit$/ });

describe('unit:unit-picker', () => {
  it('Auto, a catalogue unit, Auto again, and a custom suffix', async () => {
    const { calls, user } = mount();
    expect(trigger()).toHaveTextContent('Auto');
    await user.click(trigger());
    const list = await screen.findByRole('listbox');
    expect(within(list).getAllByRole('group')).toHaveLength(5);
    for (const name of ['General', 'Time', 'Data', 'Rate', 'Percent']) {
      expect(within(list).getByRole('group', { name })).toBeInTheDocument();
    }
    await user.click(within(list).getByRole('option', { name: 'Bytes/s (IEC) · 1.5 KiB/s' }));
    expect(calls.at(-1)).toEqual({ kind: 'line', unit: { id: 'bytesPerSecond' } });
    expect(trigger()).toHaveTextContent('Bytes/s (IEC) · 1.5 KiB/s');
    await user.click(trigger());
    await user.click(await screen.findByRole('option', { name: 'Auto' }));
    expect(calls.at(-1)).toEqual({ kind: 'line' });
    expect(calls.at(-1)).not.toHaveProperty('unit');
    await user.click(trigger());
    await user.click(await screen.findByRole('option', { name: 'Custom' }));
    expect(calls.at(-1)).toEqual({ kind: 'line', unit: { id: 'custom', suffix: '' } });
    await user.type(screen.getByRole('textbox', { name: 'Suffix' }), 'rps');
    expect(calls.at(-1)).toEqual({ kind: 'line', unit: { id: 'custom', suffix: 'rps' } });
    expect(screen.queryByText(/Shown per second/)).toBeNull();
  });

  it('the rated hint, only when the rewrite changes the unit', () => {
    mount({ vis: { kind: 'line', unit: { id: 'bytes' } }, rateApplied: true });
    expect(screen.getByText('Shown per second (B/s): the query is rated')).toBeInTheDocument();
  });

  it('a rated heatmap: bucket bounds keep the unit, counts are per second', () => {
    mount({ vis: { kind: 'heatmap', unit: { id: 'bytes' } }, rateApplied: true });
    expect(
      screen.getByText('Bucket bounds in B, counts per second: the query is rated'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Shown per second/)).toBeNull();
  });

  it('Auto resolving to a heatmap says the same; Auto drawing a line rates the unit', () => {
    const vis = { kind: 'auto', unit: { id: 'count' } } as const;
    const { unmount } = render(
      <UnitField
        vis={vis}
        rateApplied
        drawnKind="heatmap"
        errorAt={() => null}
        readOnly={false}
        onVis={() => undefined}
      />,
    );
    expect(
      screen.getByText('Bucket bounds in Count (SI), counts per second: the query is rated'),
    ).toBeInTheDocument();
    unmount();
    mount({ vis, rateApplied: true, drawnKind: 'line' });
    expect(screen.getByText('Shown per second (/s): the query is rated')).toBeInTheDocument();
  });

  it('no hint for a unit the rewrite keeps', () => {
    mount({ vis: { kind: 'line', unit: { id: 'seconds' } }, rateApplied: true });
    expect(screen.queryByText(/Shown per second/)).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Suffix' })).toBeNull();
  });

  it('the keyboard: Enter opens, headers are skipped, typeahead, Enter commits, Escape does nothing', async () => {
    const { calls, user } = mount();
    trigger().focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');
    expect(document.activeElement).toHaveTextContent('Auto');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveTextContent('Count (SI) · 1.2k');
    await user.keyboard('Byt');
    expect(document.activeElement).toHaveTextContent('Bytes (IEC) · 1.5 MiB');
    await user.keyboard('{Enter}');
    expect(calls.at(-1)).toEqual({ kind: 'line', unit: { id: 'bytes' } });
    // React Aria restores focus to the trigger once the popover has closed (a later task).
    await waitFor(() => {
      expect(trigger()).toHaveFocus();
    });
    const n = calls.length;
    await user.keyboard('{Enter}');
    await screen.findByRole('listbox');
    await user.keyboard('{Escape}');
    expect(calls).toHaveLength(n);
  });

  it('the suffix error is on the Suffix textbox', () => {
    const text = 'Suffix: 1 to 16 characters, no spaces';
    mount({ vis: { kind: 'line', unit: { id: 'custom', suffix: '' } } });
    const box = screen.getByRole('textbox', { name: 'Suffix' });
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription(text);
  });

  it('a /vis/unit field error shows on the Suffix textbox', () => {
    const text = 'Suffix: 1 to 16 characters, no spaces';
    mount({
      vis: { kind: 'line', unit: { id: 'custom', suffix: 'rps' } },
      errorAt: (suffix) => (suffix === '' ? text : null),
    });
    const box = screen.getByRole('textbox', { name: 'Suffix' });
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(box).toHaveAccessibleDescription(text);
  });
});
