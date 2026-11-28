import { describe, expect, it } from 'vitest';
import { type Box, placeReadout, type ReadoutInput } from './readout';

const VIEW = { width: 1200, height: 800 };
const CARD = { width: 200, height: 100 };
const GAP = 8;

function input(panel: Box, over: Partial<ReadoutInput> = {}): ReadoutInput {
  return {
    panel,
    plot: { x: panel.x + 40, y: panel.y + 40, width: panel.width - 50, height: panel.height - 70 },
    card: CARD,
    cursorX: panel.x + panel.width / 2,
    cursorY: panel.y + panel.height / 2,
    viewport: VIEW,
    gap: GAP,
    ...over,
  };
}

/** True when the card at `p` overlaps the plot. */
function covers(i: ReadoutInput, x: number, y: number): boolean {
  const { plot, card } = i;
  return (
    x < plot.x + plot.width &&
    x + card.width > plot.x &&
    y < plot.y + plot.height &&
    y + card.height > plot.y
  );
}

describe('placeReadout', () => {
  it('sits right of the panel, centred on the cursor', () => {
    const i = input({ x: 100, y: 200, width: 400, height: 300 });
    const p = placeReadout(i);
    expect(p).toEqual({ side: 'right', x: 508, y: 300 });
    expect(covers(i, p.x, p.y)).toBe(false);
  });

  it('flips left when the right has no room', () => {
    const i = input({ x: 700, y: 200, width: 400, height: 300 });
    const p = placeReadout(i);
    expect(p).toEqual({ side: 'left', x: 492, y: 300 });
    expect(covers(i, p.x, p.y)).toBe(false);
  });

  it('docks above the plot when neither side has room (a full-width panel)', () => {
    const i = input({ x: 0, y: 300, width: 1200, height: 400 });
    const p = placeReadout(i);
    expect(p.side).toBe('above');
    expect(p.y).toBe(340 - GAP - CARD.height);
    expect(p.x).toBe(600 - CARD.width / 2);
    expect(covers(i, p.x, p.y)).toBe(false);
  });

  it('docks below the plot when there is no room above either', () => {
    const i = input({ x: 0, y: 0, width: 1200, height: 400 });
    const p = placeReadout(i);
    expect(p.side).toBe('below');
    expect(p.y).toBe(370 + GAP);
    expect(covers(i, p.x, p.y)).toBe(false);
  });

  it('clamps vertically to the viewport beside the panel', () => {
    const top = placeReadout(input({ x: 100, y: 0, width: 400, height: 300 }, { cursorY: 5 }));
    expect(top.y).toBe(GAP);
    const bottom = placeReadout(
      input({ x: 100, y: 500, width: 400, height: 300 }, { cursorY: 795 }),
    );
    expect(bottom.y).toBe(VIEW.height - GAP - CARD.height);
  });

  it('clamps horizontally to the viewport when docked', () => {
    const panel = { x: 0, y: 300, width: 1200, height: 400 };
    expect(placeReadout(input(panel, { cursorX: 3 })).x).toBe(GAP);
    expect(placeReadout(input(panel, { cursorX: 1199 })).x).toBe(VIEW.width - GAP - CARD.width);
  });

  it('keeps the top edge on screen for a card taller than the viewport', () => {
    const p = placeReadout(
      input({ x: 100, y: 0, width: 400, height: 300 }, { card: { width: 200, height: 900 } }),
    );
    expect(p.side).toBe('right');
    expect(p.y).toBe(GAP);
  });
});
