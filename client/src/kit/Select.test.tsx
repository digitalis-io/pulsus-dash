/** The kit Select's option groups (#290 §2; T08-007): sections with a header, keyboard unchanged. */
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

describe('Select groups', () => {
  it('groups A, A, B: two named groups; the keyboard walks the options in order', async () => {
    const onChange = vi.fn();
    render(
      <Select
        label="Pick"
        value="a1"
        options={[
          { id: 'a1', label: 'One', group: 'A' },
          { id: 'a2', label: 'Two', group: 'A' },
          { id: 'b1', label: 'Three', group: 'B' },
        ]}
        onChange={onChange}
      />,
    );
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: /Pick$/ });
    trigger.focus();
    await user.keyboard('{Enter}');
    const list = await screen.findByRole('listbox');
    const groups = within(list).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('aria-labelledby'))).toHaveLength(2);
    expect(within(list).getByRole('group', { name: 'A' })).toBeInTheDocument();
    expect(within(list).getByRole('group', { name: 'B' })).toBeInTheDocument();
    expect(
      within(within(list).getByRole('group', { name: 'A' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['One', 'Two']);
    expect(document.activeElement).toHaveTextContent('One');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveTextContent('Two');
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toHaveTextContent('Three');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('b1');
  });

  it('options without a group render as before', async () => {
    render(
      <Select
        label="Pick"
        value="x"
        options={[
          { id: 'x', label: 'X' },
          { id: 'y', label: 'Y' },
        ]}
        onChange={() => undefined}
      />,
    );
    await userEvent.setup().click(screen.getByRole('button', { name: /Pick$/ }));
    const list = await screen.findByRole('listbox');
    expect(within(list).queryAllByRole('group')).toHaveLength(0);
    expect(within(list).getAllByRole('option')).toHaveLength(2);
  });
});
