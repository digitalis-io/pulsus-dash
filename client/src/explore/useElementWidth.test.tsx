import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { installResizeObserver, liveObservers, resizeAll } from '../test/fakeResizeObserver';
import { useElementWidth } from './useElementWidth';

function Probe({ attached }: { attached: boolean }) {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  return (
    <>
      <p>{width === null ? 'none' : String(width)}</p>
      {attached && <div ref={ref} />}
    </>
  );
}

beforeEach(() => {
  installResizeObserver();
});

describe('useElementWidth', () => {
  it('rounds the content width, 0 is null, and disconnects', () => {
    const { rerender, unmount } = render(<Probe attached />);
    expect(screen.getByText('none')).toBeInTheDocument();
    act(() => {
      resizeAll(1000.4, 10);
    });
    expect(screen.getByText('1000')).toBeInTheDocument();
    act(() => {
      resizeAll(0, 10);
    });
    expect(screen.getByText('none')).toBeInTheDocument();
    expect(liveObservers()).toBe(1);
    rerender(<Probe attached={false} />);
    expect(liveObservers()).toBe(0);
    rerender(<Probe attached />);
    expect(liveObservers()).toBe(1);
    unmount();
    expect(liveObservers()).toBe(0);
  });
});
