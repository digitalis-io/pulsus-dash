import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Completeness } from '../../data/decode';
import { EMPTY_COMPLETENESS } from '../../test/histogramFixtures';
import { CompletenessNotice } from './CompletenessNotice';

const c = (o: Partial<Completeness>): Completeness => ({ ...EMPTY_COMPLETENESS, ...o });

describe('CompletenessNotice', () => {
  it('truncated: badge, five warnings, more, Narrow', () => {
    const onNarrow = vi.fn();
    const warnings = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7'];
    render(
      <CompletenessNotice completeness={c({ truncated: true, warnings })} onNarrow={onNarrow} />,
    );
    const box = screen.getByRole('status', { name: 'Query notices' });
    const badge = box.querySelector('[data-badge="partial"]');
    expect(badge).toHaveTextContent('Partial data');
    const list = within(box).getByRole('list', { name: 'Partial data' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'and 2 more']);
    fireEvent.click(within(box).getByRole('button', { name: 'Narrow the time range' }));
    expect(onNarrow).toHaveBeenCalledTimes(1);
  });

  it('warnings only: the Warnings badge, no Narrow', () => {
    render(
      <CompletenessNotice
        completeness={c({ truncated: false, warnings: ['w1', 'w2'], infos: [] })}
        onNarrow={vi.fn()}
      />,
    );
    const box = screen.getByRole('status', { name: 'Query notices' });
    const badge = box.querySelector('[data-badge="warnings"]');
    expect(badge).toHaveTextContent('Warnings');
    expect(badge?.className).toMatch(/badge/);
    const list = within(box).getByRole('list', { name: 'Warnings' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['w1', 'w2']);
    expect(within(box).queryByRole('button')).toBeNull();
    expect(within(box).queryByText('Notes')).toBeNull();
    expect(within(box).queryByText('Partial data')).toBeNull();
  });

  it('infos only: Notes, no badge', () => {
    render(<CompletenessNotice completeness={c({ infos: ['i1'] })} onNarrow={vi.fn()} />);
    const box = screen.getByRole('status', { name: 'Query notices' });
    expect(within(box).getByRole('list', { name: 'Notes' })).toHaveTextContent('i1');
    expect(box.querySelector('[data-badge]')).toBeNull();
  });

  it('complete: nothing', () => {
    const { container } = render(
      <CompletenessNotice completeness={EMPTY_COMPLETENESS} onNarrow={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
