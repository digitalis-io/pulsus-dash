/**
 * The Text widget's view (plan #198 Part 3a §3.1, §4.2, §5): `unit:text-widget`,
 * `unit:text-region`, `unit:text-overflow`, `unit:text-invalid` and `unit:text-widget-vars`.
 *
 * Each test loads `TextBody` in a fresh module registry, so the lazy Markdown entry starts
 * unloaded: the mocked `./TextMarkdown` counts its loads and can stay pending or reject, and the
 * mocked renderer module counts its calls. Origin and hosts as T24 §10 (`.test` hosts).
 */
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardSpec, FieldError, WidgetPanelSpec } from '../../api/types';
import { messages } from '../../i18n/messages.en-GB';
import { installResizeObserver, resizeOf } from '../../test/fakeResizeObserver';

const ctl = vi.hoisted(() => ({
  /** Loads of `./TextMarkdown` (its factory runs once per fresh registry). */
  loads: 0,
  mode: 'ok',
  /** Renders of `TextContent`. */
  contentRenders: 0,
  /** Calls of `renderMarkdown` and `renderCode`. */
  renders: 0,
}));

vi.mock('../../security/sanitise/markdown', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../security/sanitise/markdown')>();
  return {
    ...m,
    renderMarkdown: (...a: Parameters<typeof m.renderMarkdown>) => {
      ctl.renders++;
      return m.renderMarkdown(...a);
    },
    renderCode: (...a: Parameters<typeof m.renderCode>) => {
      ctl.renders++;
      return m.renderCode(...a);
    },
  };
});

/** The lazy entry, counted; pending or rejecting as `ctl.mode` says. */
async function textMarkdownMock(importOriginal: <T>() => Promise<T>) {
  ctl.loads++;
  if (ctl.mode === 'pending') await new Promise(() => undefined);
  if (ctl.mode === 'reject') throw new Error('chunk failed');
  const m = await importOriginal<typeof import('./TextMarkdown')>();
  return {
    ...m,
    TextContent: (p: Parameters<typeof m.TextContent>[0]) => {
      ctl.contentRenders++;
      return m.TextContent(p);
    },
  };
}

/** `TextBody`, `TextEditorBody`, the run context and the renderer, from one fresh registry. */
async function fresh(mode: 'ok' | 'pending' | 'reject' = 'ok') {
  vi.resetModules();
  // Registered again for each registry, so the mode applies to this load.
  vi.doMock('./TextMarkdown', textMarkdownMock);
  ctl.mode = mode;
  ctl.loads = 0;
  ctl.contentRenders = 0;
  ctl.renders = 0;
  const [body, editor, run, md, spec] = await Promise.all([
    import('./TextBody'),
    import('./TextEditorBody'),
    import('../../boards/boardRunContext'),
    import('../../security/sanitise/markdown'),
    import('../../boards/spec'),
  ]);
  const ctx = (vars: ReadonlyMap<string, string>, children: ReactNode) => (
    <run.BoardRunContext.Provider
      value={{
        vars,
        widths: {
          get: () => null,
          set: () => undefined,
          retain: () => undefined,
          subscribe: () => () => undefined,
        },
        visibility: { observe: () => () => undefined, disconnect: () => undefined },
        timeReady: true,
      }}
    >
      {children}
    </run.BoardRunContext.Provider>
  );
  /** The panel on a board: its frame's heading names the region. */
  const board = (
    panel: WidgetPanelSpec,
    o: { vars?: ReadonlyMap<string, string>; editing?: boolean } = {},
  ) =>
    ctx(
      o.vars ?? VARS,
      <section>
        <h3 id="heading">{panel.title === '' ? 'Untitled panel' : panel.title}</h3>
        <body.TextBody
          panel={panel}
          name={{ labelledBy: 'heading' }}
          editing={o.editing ?? false}
          context="board"
        />
      </section>,
    );
  /** The panel in the editor: its preview. */
  const preview = (panel: WidgetPanelSpec, vars: ReadonlyMap<string, string> = VARS) =>
    ctx(
      vars,
      <editor.TextEditorBody
        panel={panel}
        title={panel.title}
        pointer="/panels/0"
        fields={[]}
        readOnly={false}
        original={panel.vis}
        onVis={() => undefined}
      />,
    );
  return { body, md, spec, board, preview, ctx };
}

const VARS: ReadonlyMap<string, string> = new Map([['env', 'prod']]);

function text(
  content: string,
  more: Record<string, unknown> = {},
  title = 'Runbook',
): WidgetPanelSpec {
  return {
    id: 'p-1',
    title,
    grid: { x: 0, y: 0, w: 6, h: 6 },
    vis: { kind: 'text', options: { mode: 'markdown', content, ...more } },
  };
}

function code(content: string, language = 'promql'): WidgetPanelSpec {
  return text(content, { mode: 'code', language });
}

/** The T24 §10 removal-redaction input: a `javascript:` link holding a password and a token. */
const SECRET = "[x](javascript:fetch('https://u:hunter2@e.test/?token=abc'))";

/**
 * Lets the lazy entry, the deferred values and their transition settle: the first load of the
 * Markdown packages can take a while on a busy runner (at most 5 s).
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const loading = document.querySelector('[data-text-state="loading"]') !== null;
    if (i >= 5 && (!loading || ctl.mode === 'pending')) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, i < 5 ? 0 : 10));
    });
  }
}

function region(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

beforeEach(() => {
  installResizeObserver();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unit:text-widget', () => {
  it('Markdown: headings, new-tab links and variables', async () => {
    const k = await fresh();
    render(k.board(text('# R\n\nSee [the guide](https://docs.e.test/a).\n\nEnv $env')));
    await settle();
    const r = region('Runbook');
    expect(r).toHaveAttribute('data-text-state', 'content');
    expect(within(r).getByRole('heading', { level: 4, name: 'R' })).toBeInTheDocument();
    const a = r.querySelector('a[target="_blank"]');
    expect(a).not.toBeNull();
    expect((a?.getAttribute('rel') ?? '').split(' ').sort()).toEqual([
      'nofollow',
      'noopener',
      'noreferrer',
    ]);
    expect(within(r).getByText('Env prod')).toBeInTheDocument();
  });

  it('code: the source verbatim, never interpolated', async () => {
    const k = await fresh();
    render(k.board(code('sum(rate(x{env="$env"}[5m]))')));
    await settle();
    const c = region('Runbook').querySelector('pre > code[data-lang="promql"]');
    expect(c?.textContent).toBe('sum(rate(x{env="$env"}[5m]))');
  });

  it('empty and blank content: the empty state, with no chunk load', async () => {
    const k = await fresh();
    const v = render(k.board(text('')));
    await settle();
    expect(within(region('Runbook')).getByText(messages['widget.text.empty'])).toBeInTheDocument();
    v.rerender(k.board(text('  '), { editing: true }));
    await settle();
    expect(within(region('Runbook')).getByText(messages['widget.text.write'])).toBeInTheDocument();
    expect(region('Runbook')).toHaveAttribute('data-text-state', 'empty');
    expect(ctl.loads).toBe(0);
    expect(ctl.renders).toBe(0);
  });

  it('removals are logged once per result, without content', async () => {
    const k = await fresh();
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    const v = render(k.board(text(SECRET)));
    await settle();
    v.rerender(k.board(text(SECRET)));
    await settle();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith({
      panelId: 'p-1',
      removals: [{ kind: 'linkScheme', line: 1 }],
    });
    const shown = region('Runbook').textContent;
    for (const s of ['hunter2', 'token']) expect(shown).not.toContain(s);
  });

  it('a chunk that fails to load: the load-failed message', async () => {
    const k = await fresh('reject');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(k.board(text('# R')));
    await settle();
    const r = region('Runbook');
    expect(within(r).getByText(messages['widget.text.loadFailed'])).toBeInTheDocument();
    expect(r).toHaveAttribute('data-text-state', 'error');
  });
});

describe('unit:text-region', () => {
  const STATES: [string, 'ok' | 'pending' | 'reject', (title: string) => WidgetPanelSpec][] = [
    ['empty', 'ok', (title) => text('', {}, title)],
    ['invalid', 'ok', (title) => text('x', { language: 'go' }, title)],
    ['loading', 'pending', (title) => text('# R', {}, title)],
    ['error', 'reject', (title) => text('# R', {}, title)],
    ['content', 'ok', (title) => text('# R', {}, title)],
  ];

  for (const [state, mode, panel] of STATES) {
    it(`${state}: the region is named on the board and in the preview`, async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const k = await fresh(mode);
      const b = render(k.board(panel('Runbook')));
      await settle();
      expect(region('Runbook')).toHaveAttribute('data-text-state', state);
      b.unmount();
      for (const [title, name] of [
        ['Runbook', 'Preview: Runbook'],
        ['', 'Preview: Text'],
      ] as const) {
        const p = render(k.preview(panel(title)));
        await settle();
        expect(region(name)).toHaveAttribute('data-text-state', state);
        p.unmount();
      }
    });
  }
});

describe('unit:text-overflow', () => {
  const box = { h: 100 };
  beforeEach(() => {
    box.h = 100;
    // The region's client height is fixed; its scroll height is the measured content's length.
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.hasAttribute('data-text-body') ? box.h : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
      configurable: true,
      get(this: HTMLElement) {
        if (!this.hasAttribute('data-text-body')) return 0;
        const n = this.querySelector('[data-text-measure]')?.textContent.length ?? 0;
        return Math.max(box.h, n);
      },
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
  });

  it('a tab stop exactly while the content overflows', async () => {
    const k = await fresh();
    const tab = () => region('Runbook').getAttribute('tabindex');
    const v = render(k.board(text('a'.repeat(50))));
    await settle();
    expect(tab()).toBeNull();
    v.rerender(k.board(text('a'.repeat(200))));
    await settle();
    expect(tab()).toBe('0');
    v.rerender(k.board(text('a'.repeat(50))));
    await settle();
    expect(tab()).toBeNull();
    v.rerender(k.board(text('a'.repeat(101))));
    await settle();
    expect(tab()).toBe('0');
    v.rerender(k.board(text('a'.repeat(100))));
    await settle();
    expect(tab()).toBeNull();
    // A variable's value grows and shrinks: the panel is unchanged.
    const panel = text('$env');
    v.rerender(k.board(panel, { vars: new Map([['env', 'x'.repeat(150)]]) }));
    await settle();
    expect(tab()).toBe('0');
    v.rerender(k.board(panel, { vars: new Map([['env', 'x']]) }));
    await settle();
    expect(tab()).toBeNull();
    // The container grows around overflowing content: the observer measures again.
    v.rerender(k.board(text('a'.repeat(200))));
    await settle();
    expect(tab()).toBe('0');
    box.h = 300;
    act(() => {
      resizeOf(region('Runbook'), 400, 300);
    });
    expect(tab()).toBeNull();
  });
});

describe('unit:text-invalid', () => {
  const FIXTURES = join(process.cwd(), '..', 'api', 'fixtures', 'board-spec');
  interface Row {
    name: string;
    spec: BoardSpec;
    fields: { pointer: string; message_key: string }[];
  }
  const rows = (JSON.parse(readFileSync(join(FIXTURES, 'invalid.json'), 'utf8')) as Row[]).filter(
    (r) =>
      typeof r.spec === 'object' &&
      Array.isArray(r.spec.panels) &&
      r.spec.panels.length === 1 &&
      (r.spec.panels[0] as { vis?: { kind?: string } } | undefined)?.vis?.kind === 'text' &&
      r.fields.every((f) => f.pointer.startsWith('/panels/0/vis')),
  );

  it('the fixture has text rows', () => {
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it('a too-long draft is never rendered; the preview says why', async () => {
    const k = await fresh();
    const big = text(`${'€'.repeat(21_845)}aa`);
    expect(new TextEncoder().encode(big.vis.options?.content ?? '').length).toBe(65_537);
    const p = render(k.preview(big));
    await settle();
    const r = region('Preview: Runbook');
    const status = within(r).getByRole('status');
    expect(status).toHaveTextContent('Preview unavailable: Use at most 65 536 bytes.');
    expect(r).toHaveAttribute('aria-describedby', status.id);
    expect(r).toHaveAttribute('data-text-state', 'invalid');
    p.unmount();
    render(k.board(big));
    await settle();
    expect(
      within(region('Runbook')).getByText("This text can't be shown: Use at most 65 536 bytes."),
    ).toBeInTheDocument();
    expect(ctl.renders).toBe(0);
    expect(ctl.loads).toBe(0);
  });

  it('a language in Markdown mode is invalid', async () => {
    const k = await fresh();
    render(k.board(text('x', { language: 'go' })));
    await settle();
    expect(
      within(region('Runbook')).getByText(
        "This text can't be shown: Choose a listed language (code mode).",
      ),
    ).toBeInTheDocument();
    expect(ctl.renders).toBe(0);
    expect(ctl.loads).toBe(0);
  });

  it('widgetVisErrors: the fixture rows, relative to the panel', async () => {
    const k = await fresh();
    for (const r of rows) {
      const panel = r.spec.panels[0] as WidgetPanelSpec;
      const want: FieldError[] = r.fields.map((f) => ({
        pointer: f.pointer.slice('/panels/0'.length),
        messageKey: f.message_key,
      }));
      expect(k.spec.widgetVisErrors(panel), r.name).toEqual(want);
    }
    expect(k.spec.widgetVisErrors(text('fine'))).toEqual([]);
  });
});

describe('unit:text-widget-vars', () => {
  it('only the referenced variables reach the renderer', async () => {
    const k = await fresh();
    const panel = text('Env $env');
    const v = render(k.board(panel, { vars: new Map([['env', 'prod']]) }));
    await settle();
    expect(within(region('Runbook')).getByText('Env prod')).toBeInTheDocument();
    const before = k.md.memoStats();
    v.rerender(k.board(panel, { vars: new Map([['env', 'stage']]) }));
    await settle();
    expect(within(region('Runbook')).getByText('Env stage')).toBeInTheDocument();
    const after = k.md.memoStats();
    expect(after.misses - before.misses).toBe(1);
    const renders = ctl.contentRenders;
    const lookups = after.hits + after.misses;
    v.rerender(
      k.board(panel, {
        vars: new Map([
          ['env', 'stage'],
          ['zone', 'eu'],
        ]),
      }),
    );
    await settle();
    expect(ctl.contentRenders).toBe(renders);
    const last = k.md.memoStats();
    expect(last.hits + last.misses).toBe(lookups);
  });

  it('textVars: the set references in name order; none in code mode', async () => {
    const k = await fresh();
    const all = new Map([
      ['zone', 'eu'],
      ['env', 'prod'],
      ['region', 'west'],
    ]);
    const o = {
      mode: 'markdown' as const,
      content: '$region ${env} $missing',
      language: 'plaintext' as const,
    };
    expect([...k.body.textVars(all, o)]).toEqual([
      ['env', 'prod'],
      ['region', 'west'],
    ]);
    // Memoised by its entries: equal entries give the same map.
    expect(k.body.textVars(new Map(all), o)).toBe(k.body.textVars(all, o));
    expect([...k.body.textVars(all, { ...o, mode: 'code' })]).toEqual([]);
  });
});
