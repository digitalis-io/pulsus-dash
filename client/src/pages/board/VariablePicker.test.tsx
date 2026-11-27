/** unit:variable-picker (SRF-017, T08-007, plan #289 §4.4). */
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { useEffect, useState as useStateOf } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BoardVariable } from '../../api/types';
import { resolveVariables, type VariableList } from '../../boards/resolveVariables';
import { decodeValue, readBoardParams } from '../../state/boardParams';
import { readContextSearch } from '../../state/contextSearch';
import { useBoardParams } from '../../state/useBoardParams';
import { renderRouted } from '../../test/routedHarness';
import { VariablePicker } from './VariablePicker';

const NODE: BoardVariable = {
  name: 'node',
  label: 'Node',
  kind: 'query',
  query: { lang: 'promql', text: 'label_values(up, instance)' },
  multi: true,
  includeAll: true,
  sort: 'none',
  refresh: 'load',
};
const ENV: BoardVariable = {
  name: 'env',
  label: 'Environment',
  kind: 'custom',
  values: ['a', 'b', 'c'],
  multi: false,
  includeAll: false,
  sort: 'none',
};
const BASE = '/t/demo/board/b-1?from=now-1h&to=now&refresh=off';
const ready = (values: readonly string[]): VariableList => ({
  status: 'ready',
  values,
  truncated: false,
});

const listSetter: { set: (l: VariableList) => void } = { set: () => undefined };
const setList = (l: VariableList): void => {
  listSetter.set(l);
};

function Host({
  def,
  initial,
  onRetry,
}: {
  def: BoardVariable;
  initial: VariableList | undefined;
  onRetry: () => void;
}) {
  const [list, set] = useStateOf(initial);
  useEffect(() => {
    listSetter.set = set;
  }, [set]);
  const params = useBoardParams([], new Set([def.name]));
  const lists = new Map<string, VariableList>(list === undefined ? [] : [[def.name, list]]);
  const state = resolveVariables([def], params.params.vars, lists).get(def.name) ?? {
    kind: 'unset' as const,
  };
  return (
    <>
      <VariablePicker
        def={def}
        state={state}
        list={def.kind === 'custom' ? ready(def.values ?? []) : list}
        labelOf={(n) => (n === def.name ? def.label : n)}
        onCommit={(vs) => params.setVarValues(def.name, vs)}
        onRetry={onRetry}
      />
      <pre data-testid="value">
        {JSON.stringify(state.kind === 'ready' ? state.value : state.kind)}
      </pre>
    </>
  );
}

function mount(def: BoardVariable, list: VariableList | undefined, search = '') {
  const onRetry = vi.fn();
  const r = renderRouted(<Host def={def} initial={list} onRetry={onRetry} />, {
    url: BASE + search,
  });
  const user = userEvent.setup();
  /** The defined variable's encoded address values now. */
  const address = (): readonly string[] => {
    const rest = readContextSearch(new URLSearchParams(r.router.state.location.search), {
      nowMs: 0,
      timeZone: 'UTC',
    }).rest;
    return readBoardParams(rest, new Set([def.name])).vars.get(def.name) ?? [];
  };
  // The chip is behind the open popover (aria-hidden) too.
  const chip = () =>
    screen.getByRole('button', { name: new RegExp(`^Variable ${def.label}: `), hidden: true });
  const open = async () => {
    await user.click(chip());
    return screen.findByRole('dialog', { name: `Variable ${def.label}` });
  };
  const option = (name: string | RegExp) => screen.getByRole('option', { name });
  const checked = (name: string | RegExp) => option(name).getAttribute('aria-selected') === 'true';
  return { ...r, user, onRetry, address, chip, open, option, checked };
}

const values = (n: number, f = (i: number) => `n${String(i).padStart(3, '0')}`) =>
  Array.from({ length: n }, (_, i) => f(i));

describe('unit:variable-picker', () => {
  it('multi with All: All clears the rows, a row clears All, Apply writes the values', async () => {
    const m = mount(NODE, ready(['a', 'b', 'c']), '&var-node=%24__all');
    expect(m.chip()).toHaveAccessibleName('Variable Node: All');
    expect(m.chip()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(m.chip()).toHaveAttribute('aria-expanded', 'false');
    await m.open();
    expect(m.chip()).toHaveAttribute('aria-expanded', 'true');
    expect(m.checked('All')).toBe(true);
    await m.user.click(m.option('a'));
    expect(m.checked('All')).toBe(false);
    expect(m.checked('a')).toBe(true);
    await m.user.click(m.option('b'));
    await m.user.click(m.option('All'));
    expect(m.checked('a')).toBe(false);
    expect(m.checked('All')).toBe(true);
    await m.user.click(m.option('a'));
    await m.user.click(m.option('b'));
    await m.user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(m.address()).toEqual(['a', 'b']);
    });
    expect(m.router.state.location.search).toContain('var-node=a&var-node=b');
  });

  it('Escape discards the draft', async () => {
    const m = mount(NODE, ready(['a', 'b']));
    await m.open();
    await m.user.click(m.option('b'));
    await m.user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(m.address()).toEqual([]);
    });
  });

  it('shows 200 matches, then the rest as a count', async () => {
    const m = mount(NODE, ready(values(250)));
    const d = await m.open();
    expect(
      within(d)
        .getAllByRole('option')
        .filter((o) => /^n\d+$/.test(o.textContent)),
    ).toHaveLength(200);
    expect(within(d).getByText('50 more, type to narrow')).toBeInTheDocument();
  });

  it('single-select: choosing a row commits it and closes', async () => {
    const m = mount(ENV, undefined);
    expect(m.chip()).toHaveAccessibleName('Variable Environment: a');
    await m.open();
    await m.user.click(m.option('b'));
    await waitFor(() => {
      expect(m.address()).toEqual(['b']);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('Reset to default removes the address values', async () => {
    const m = mount(NODE, ready(['a', 'b']), '&var-node=b');
    await m.open();
    await m.user.click(screen.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => {
      expect(m.address()).toEqual([]);
    });
  });

  it('a custom value is tagged, kept through a search, and removed alone', async () => {
    const m = mount(NODE, ready(['a', 'b']), '&var-node=a&var-node=zz');
    await m.open();
    expect(m.option('zz, custom')).toBeInTheDocument();
    expect(m.checked('zz, custom')).toBe(true);
    await m.user.type(screen.getByRole('searchbox'), 'b');
    expect(m.option('zz, custom')).toBeInTheDocument();
    await m.user.click(m.option('zz, custom'));
    await m.user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(m.address()).toEqual(['a']);
    });
  });

  it('a value no longer listed after a refetch shows as custom', async () => {
    const m = mount(NODE, ready(['a', 'b']), '&var-node=a');
    act(() => {
      setList(ready(['b', 'c']));
    });
    await m.open();
    expect(m.option('a, custom')).toBeInTheDocument();
    expect(m.checked('a, custom')).toBe(true);
  });

  it('Retry fetches a failed list again; announcements', async () => {
    const m = mount(NODE, { status: 'failed', error: new Error('x') });
    await m.open();
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Values unavailable');
    });
    await m.user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(m.onRetry).toHaveBeenCalledTimes(1);
    act(() => {
      setList({ status: 'loading' });
    });
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('Loading values');
    });
    act(() => {
      setList(ready(['a', 'b', 'c']));
    });
    await m.user.click(m.option('a'));
    await m.user.click(m.option('b'));
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('2 selected');
    });
  });

  it('keyboard: search first, arrows and Enter, Tab to Apply, Ctrl+Enter applies, focus back', async () => {
    const m = mount({ ...NODE, default: ['$__all'] }, ready(['a', 'b', 'c']));
    m.chip().focus();
    await m.user.keyboard('{Enter}');
    await screen.findByRole('dialog', { name: 'Variable Node' });
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
    await m.user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(m.checked('a')).toBe(true);
    expect(m.checked('All')).toBe(false);
    const apply = screen.getByRole('button', { name: 'Apply' });
    for (let i = 0; i < 3 && document.activeElement !== apply; i++) await m.user.tab();
    expect(document.activeElement).toBe(apply);
    screen.getByRole('searchbox').focus();
    await m.user.keyboard('{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(m.address()).toEqual(['a']);
    });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(m.chip());
    });
  });

  it('a listed $__all literal next to All', async () => {
    const m = mount(NODE, ready(['$__all', 'b']), '&var-node=%24__all');
    await m.open();
    expect(m.checked('All')).toBe(true);
    await m.user.click(m.option('$__all'));
    await m.user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(m.address()).toEqual(['$$__all']);
    });
    await waitFor(() => {
      expect(m.address().map(decodeValue)).toEqual([{ value: '$__all' }]);
    });
    await m.open();
    expect(m.checked('$__all')).toBe(true);
    expect(m.checked('All')).toBe(false);
  });

  it('a 200-character literal starting with $ round-trips to the panels', async () => {
    const lit = '$' + 'q'.repeat(199);
    // The first listed value, b, is selected; choosing the literal and dropping b leaves it.
    const m = mount(NODE, ready(['b', lit]));
    await m.open();
    await m.user.click(m.option(lit));
    await m.user.click(m.option('b'));
    await m.user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(m.address()).toEqual(['$' + lit]);
    });
    expect(Array.from('$' + lit).length).toBe(201);
    expect(JSON.parse(screen.getByTestId('value').textContent)).toEqual({ values: [lit] });
    await m.open();
    expect(m.checked(lit)).toBe(true);
  });

  it('at 200 values the other rows are disabled, All stays enabled and clears the rows', async () => {
    const all = values(250);
    const search = all
      .slice(0, 200)
      .map((v) => `&var-node=${v}`)
      .join('');
    const m = mount(NODE, ready(all), search);
    const d = await m.open();
    expect(
      within(d).getByText('Selection too large; use All or narrow the search'),
    ).toBeInTheDocument();
    await m.user.type(screen.getByRole('searchbox'), 'n2');
    expect(m.option('n240')).toHaveAttribute('aria-disabled', 'true');
    await m.user.click(m.option('n240'));
    expect(m.checked('n240')).toBe(false);
    expect(m.option('All')).not.toHaveAttribute('aria-disabled', 'true');
    await m.user.click(m.option('All'));
    expect(m.checked('All')).toBe(true);
    await m.user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      expect(m.address()).toEqual(['$__all']);
    });
  });

  it('a non-ASCII selection one row short of 65 536 bytes disables the other rows', async () => {
    // Values of 603 bytes (150 four-byte runes and 3 digits): 108 of them are 2 + 107 + 108 × 605
    // = 65 449 bytes, and one more would be 66 055.
    const big = (i: number) => '\u{1F600}'.repeat(150) + String(i).padStart(3, '0');
    const all = values(120, big);
    const chosen = all.slice(0, 108);
    const m = mount(
      NODE,
      ready(all),
      chosen.map((v) => `&var-node=${encodeURIComponent(v)}`).join(''),
    );
    const d = await m.open();
    expect(
      within(d).getByText('Selection too large; use All or narrow the search'),
    ).toBeInTheDocument();
    const other = big(110);
    expect(m.option(other)).toHaveAttribute('aria-disabled', 'true');
    await m.user.click(m.option(other));
    expect(m.checked(other)).toBe(false);
    expect(m.option('All')).not.toHaveAttribute('aria-disabled', 'true');
    await m.user.click(m.option('All'));
    expect(m.checked('All')).toBe(true);
  });

  it('is clean under axe with the dialog open', async () => {
    const m = mount(NODE, ready(['a', 'b']), '&var-node=a&var-node=zz');
    await m.open();
    const r = await axe.run(document.body, {
      rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    });
    expect(r.violations.map((v) => v.id)).toEqual([]);
  });
});
