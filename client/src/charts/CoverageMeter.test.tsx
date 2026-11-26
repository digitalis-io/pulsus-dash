/** The coverage meter (VIZ-027, T22-006; plan #173 Part 2 §4.4, §5 meter). */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Completeness } from '../data/decode';
import { EMPTY_COVERAGE, type Coverage } from '../data/frames';
import { CoverageMeter } from './CoverageMeter';

const run = (o: Partial<Completeness> = {}): Completeness => ({ ...EMPTY_COVERAGE.query, ...o });
const cov = (query: Completeness, baseline: Completeness | null = null): Coverage => ({
  ...EMPTY_COVERAGE,
  total: 5,
  drawn: 5,
  query,
  baseline,
});

describe('meter', () => {
  it('complete: one status line, 100 %', () => {
    render(<CoverageMeter coverage={cov(run())} onNarrow={vi.fn()} />);
    const p = screen.getByRole('status');
    expect(p.tagName).toBe('P');
    expect(p).toHaveTextContent('100 %');
    expect(p.closest('[data-coverage-meter]')).not.toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a warning: the button opens the warnings', async () => {
    const user = userEvent.setup();
    render(
      <CoverageMeter
        coverage={cov(run({ warnings: ['series limit reached'] }))}
        onNarrow={vi.fn()}
      />,
    );
    const b = screen.getByRole('button', { name: 'Coverage: limited (1 warning)' });
    expect(b).toHaveTextContent('limited (1 warning)');
    await user.click(b);
    expect(await screen.findByText('series limit reached')).toBeInTheDocument();
    expect(screen.getByText('This query')).toBeInTheDocument();
    expect(screen.queryByText('Baseline (shifted window)')).toBeNull();
  });

  it('truncated: Narrow calls onNarrow once', async () => {
    const user = userEvent.setup();
    const onNarrow = vi.fn();
    render(<CoverageMeter coverage={cov(run({ truncated: true }))} onNarrow={onNarrow} />);
    await user.click(screen.getByRole('button', { name: 'Coverage: truncated' }));
    await user.click(await screen.findByRole('button', { name: 'Narrow the time range' }));
    expect(onNarrow).toHaveBeenCalledTimes(1);
  });

  it('baseline truncated: the baseline section only, with Narrow', async () => {
    const user = userEvent.setup();
    const onNarrow = vi.fn();
    render(<CoverageMeter coverage={cov(run(), run({ truncated: true }))} onNarrow={onNarrow} />);
    await user.click(screen.getByRole('button', { name: 'Coverage: baseline truncated' }));
    expect(await screen.findByText('Baseline (shifted window)')).toBeInTheDocument();
    expect(screen.queryByText('This query')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Narrow the time range' }));
    expect(onNarrow).toHaveBeenCalledTimes(1);
  });

  it('both runs warned: both sections', async () => {
    const user = userEvent.setup();
    render(
      <CoverageMeter
        coverage={cov(run({ warnings: ['a'] }), run({ warnings: ['b', 'c'] }))}
        onNarrow={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Coverage: limited (1 warning) · baseline limited (2 warnings)',
      }),
    );
    expect(await screen.findByText('This query')).toBeInTheDocument();
    expect(screen.getByText('Baseline (shifted window)')).toBeInTheDocument();
    for (const w of ['a', 'b', 'c']) expect(screen.getByText(w)).toBeInTheDocument();
  });
});
