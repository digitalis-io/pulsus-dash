/** Copy link refuses a link longer than the board link budget (plan #61 Part C §3.7). */
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineWrapper } from '../test/boardTestKit';
import { installResizeObserver } from '../test/fakeResizeObserver';
import { renderApp } from '../test/renderApp';

beforeEach(() => {
  installResizeObserver();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard');
});

/** `/t/demo/board/b-1?from=now-1h&to=now&refresh=off&var-x=a…a`, `total` bytes long. */
function linkOf(total: number): string {
  const head = '/t/demo/board/b-1?from=now-1h&to=now&refresh=off&var-x=';
  return head + 'a'.repeat(total - head.length);
}

async function copy(url: string) {
  const { user } = renderApp(url, { wrapper: EngineWrapper });
  const writeText = vi.fn<(s: string) => Promise<void>>(() => Promise.resolve());
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  await user.click(await screen.findByRole('button', { name: 'Share' }));
  const share = await screen.findByRole('dialog', { name: 'Share board' });
  await user.click(within(share).getByRole('checkbox', { name: 'Keep relative' }));
  await user.click(within(share).getByRole('button', { name: 'Copy link' }));
  return { share, writeText };
}

describe('copy link', () => {
  it('copy link too long', async () => {
    expect(linkOf(4097)).toHaveLength(4097);
    const long = await copy(linkOf(4097));
    expect(
      await within(long.share).findByText(
        'This link is too long to share. Remove filters or shorten values.',
      ),
    ).toBeInTheDocument();
    expect(long.writeText).not.toHaveBeenCalled();
    expect(within(long.share).queryByRole('textbox', { name: 'Share link' })).toBeNull();
  });

  it('copies a link of 4 096 bytes', async () => {
    const ok = await copy(linkOf(4096));
    await waitFor(() => {
      expect(ok.writeText).toHaveBeenCalledTimes(1);
    });
    expect(new URL(ok.writeText.mock.calls[0]?.[0] ?? '').pathname).toBe('/t/demo/board/b-1');
    expect(await within(ok.share).findByText('Link copied')).toBeInTheDocument();
  });
});
