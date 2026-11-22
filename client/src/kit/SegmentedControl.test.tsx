import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

const OPTIONS = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Beta' },
  { id: 'c', label: 'Gamma' },
] as const;

describe('SegmentedControl', () => {
  it('a radio group: arrows move, Space selects, no deselection', async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Letters" options={OPTIONS} value="a" onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Letters' });
    expect(group).toBeInTheDocument();
    const alpha = screen.getByRole('radio', { name: 'Alpha' });
    expect(alpha).toHaveAttribute('aria-checked', 'true');
    const user = userEvent.setup();
    await user.tab();
    expect(alpha).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: 'Beta' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith('b');
  });
});
