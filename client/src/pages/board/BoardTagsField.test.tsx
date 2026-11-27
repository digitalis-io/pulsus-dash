/**
 * `unit:board-tags-field` (plan #216 Part 2b §4.2, §5; T24-029, T08-007): the board's tag field adds
 * on Return and `,`, removes with Backspace and a chip's ×, keeps focus in the field, and stops at
 * 16 tags.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BoardTagsField } from './BoardTagsField';

function Harness({
  initial,
  onChange,
  error = null,
}: {
  initial: readonly string[];
  onChange: (tags: readonly string[]) => void;
  error?: string | null;
}) {
  const [tags, setTags] = useState(initial);
  return (
    <BoardTagsField
      tags={tags}
      error={error}
      readOnly={false}
      onChange={(next) => {
        onChange(next);
        setTags(next);
      }}
    />
  );
}

function setup(initial: readonly string[] = []) {
  const onChange = vi.fn<(tags: readonly string[]) => void>();
  const user = userEvent.setup();
  render(<Harness initial={initial} onChange={onChange} />);
  const input = () => screen.getByRole('textbox', { name: 'Add a tag' });
  const remove = (tag: string) => screen.getByRole('button', { name: `Remove tag ${tag}` });
  return { onChange, user, input, remove };
}

describe('unit:board-tags-field', () => {
  it('Return and `,` add; Backspace in an empty input removes the last', async () => {
    const { onChange, user, input } = setup();
    expect(screen.getByText('No tags yet. Tags let a Board list find this board.')).toBeVisible();
    await user.type(input(), 'Team:Payments{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['team:payments']);
    expect(input()).toHaveValue('');
    await user.type(input(), 'noc,');
    expect(onChange).toHaveBeenLastCalledWith(['team:payments', 'noc']);
    expect(input()).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Remove tag noc' })).toBeInTheDocument();
    await user.type(input(), '{Backspace}');
    expect(onChange).toHaveBeenLastCalledWith(['team:payments']);
  });

  it('a chip’s × moves focus to the next ×, the last one’s to the input', async () => {
    const { user, input, remove } = setup(['a', 'b', 'noc']);
    await user.click(remove('a'));
    expect(screen.queryByRole('button', { name: 'Remove tag a' })).toBeNull();
    expect(remove('b')).toHaveFocus();
    await user.click(remove('noc'));
    expect(input()).toHaveFocus();
  });

  it('an invalid or duplicate tag shows its text, which clears on typing', async () => {
    const { onChange, user, input } = setup(['a']);
    await user.type(input(), 'a{Enter}');
    expect(input()).toHaveAccessibleDescription(/Use each tag once/);
    expect(input()).toHaveValue('a');
    await user.type(input(), 'b');
    expect(input()).not.toHaveAccessibleDescription(/Use each tag once/);
    await user.clear(input());
    await user.type(input(), 'Bad!{Enter}');
    expect(input()).toHaveAccessibleDescription(/Use at most 16 tags of lower-case letters/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('16 tags disable the input and say why', () => {
    const tags = Array.from({ length: 16 }, (_, i) => `t${String(i)}`);
    setup(tags);
    expect(screen.getByRole('textbox', { name: 'Add a tag' })).toBeDisabled();
    expect(screen.getByText('A board has at most 16 tags')).toBeInTheDocument();
  });

  it('a pasted list is split at once', async () => {
    const { onChange, user, input } = setup();
    await user.click(input());
    await user.paste('a, b c');
    expect(onChange).toHaveBeenLastCalledWith(['a', 'b', 'c']);
    expect(input()).toHaveValue('');
  });
});
