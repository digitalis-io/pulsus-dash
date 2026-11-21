import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MetricPicker } from './MetricPicker';

const NAMES = Array.from({ length: 150 }, (_, i) => `metric_${String(i).padStart(3, '0')}`);

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('MetricPicker', () => {
  it('opens on focus, caps the list and picks with Enter', async () => {
    const names = vi.fn(() => Promise.resolve(NAMES));
    const onPick = vi.fn();
    render(wrap(<MetricPicker tenant="demo" names={names} meta={{}} onPick={onPick} />));
    const box = screen.getByRole('combobox', { name: 'Metric' });
    expect(box).toHaveAttribute('placeholder', 'Find a metric');
    expect(names).not.toHaveBeenCalled();
    const user = userEvent.setup();
    await user.click(box);
    const list = await screen.findByRole('listbox');
    await waitFor(() => {
      expect(list.querySelectorAll('[role="option"]')).toHaveLength(100);
    });
    expect(names).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Showing 100 of 150 metrics: keep typing to narrow')).toBeVisible();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith('metric_000');
    expect(box).toHaveValue('');
  });

  it('no names: disabled, never asked', () => {
    render(wrap(<MetricPicker tenant="demo" names={null} meta={{}} onPick={vi.fn()} />));
    expect(screen.getByRole('combobox', { name: 'Metric' })).toBeDisabled();
  });

  it('no match', async () => {
    const names = vi.fn(() => Promise.resolve(['up']));
    render(wrap(<MetricPicker tenant="demo" names={names} meta={{}} onPick={vi.fn()} />));
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Metric' }));
    await user.keyboard('zzz');
    expect(await screen.findByText('No metric matches')).toBeVisible();
  });
});
