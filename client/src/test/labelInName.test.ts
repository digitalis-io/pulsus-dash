import axe from 'axe-core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { scanLabelInName } from './labelInName';

type AxeGlobal = { axe?: typeof axe };
const g = globalThis as unknown as AxeGlobal;

/** Makes `html` the whole body (parsed, not assigned to innerHTML: T18-004). */
function setBody(html: string): void {
  document.body.replaceChildren(
    ...new DOMParser().parseFromString(html, 'text/html').body.childNodes,
  );
}

const FIXTURES: readonly (readonly [string, readonly string[]])[] = [
  ['<button aria-label="Add panel to Latency"><span></span>Add panel</button>', []],
  [
    '<button aria-label="Switch tenant, current: Demo"><span aria-hidden="true">D</span></button>',
    ['label-in-name: button "D" not in "Switch tenant, current: Demo"'],
  ],
  [
    '<button aria-label="D, switch tenant, current: Demo"><span aria-hidden="true">D</span></button>',
    [],
  ],
  [
    '<button aria-label="User menu: Ada Admin"><span aria-hidden="true">AA</span></button>',
    ['label-in-name: button "AA" not in "User menu: Ada Admin"'],
  ],
  [
    '<a href="/x" aria-label="Open settings">Edit</a>',
    ['label-in-name: a "Edit" not in "Open settings"'],
  ],
  [
    '<button aria-label="panel add">Add panel</button>',
    ['label-in-name: button "Add panel" not in "panel add"'],
  ],
  ['<button aria-label="Variable env: prod"><span>env</span> <span>prod</span></button>', []],
  ['<button aria-label="Star board"><span aria-hidden="true">★</span></button>', []],
  ['<button aria-label="Run"><span style="display:none">Cancel</span>Run</button>', []],
  [
    '<span id="l1">Refresh</span><button aria-labelledby="l1">Refresh now</button>',
    ['label-in-name: button "Refresh now" not in "Refresh"'],
  ],
  [
    '<span id="l2" aria-label="Open">Q</span><button aria-labelledby="l2">Q</button>',
    ['label-in-name: button "Q" not in "Open"'],
  ],
  ['<span id="l3" aria-label="Q, open">Q</span><button aria-labelledby="l3">Q</button>', []],
  [
    '<span id="l4">Run</span><button aria-labelledby="l4 l5">Run</button><span id="l5">query</span>',
    [],
  ],
  [
    '<div role="menuitemradio" aria-label="Thirty seconds">30s</div>',
    ['label-in-name: div[role=menuitemradio] "30s" not in "Thirty seconds"'],
  ],
  ['<button aria-label="Close" hidden>Open</button>', []],
  ['<div role="group" aria-label="Refresh"><span>Off</span></div>', []],
  ['<button>Apply</button>', []],
  ['<button aria-label="Zoë, open">Zoë</button>', []],
];

describe('scanLabelInName fixtures', () => {
  beforeAll(() => {
    g.axe = axe;
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  for (const [html, expected] of FIXTURES) {
    it(html, () => {
      setBody(html);
      expect(scanLabelInName()).toEqual(expected);
    });
  }

  it('reports a missing axe-core', () => {
    const saved = g.axe;
    delete g.axe;
    try {
      setBody('<button aria-label="Open">Edit</button>');
      expect(scanLabelInName()).toEqual(['label-in-name: axe-core not loaded']);
    } finally {
      if (saved !== undefined) g.axe = saved;
    }
  });
});
