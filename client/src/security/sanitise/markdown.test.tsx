/**
 * The Markdown renderer's unit tests (plan #198 Part 2b §5; T24 §4.2, §10): links, nodes, depth,
 * the root, the walk, pathological input, flat source lines, inline depth, iframes, images,
 * interpolation, surrogates and removal redaction. Origin `https://dash.test`; `.test` hosts only.
 */
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  logRemovals,
  MAX_DEPTH,
  memoStats,
  removalMessage,
  renderCode,
  renderMarkdown,
  sourceLines,
  type MarkdownOpts,
  type Removal,
  type RenderPolicy,
} from './markdown';
import styles from './markdown.module.css';

const APP = 'https://dash.test';
const ENV = new Map([['env', 'prod']]);
const NEW_TAB = '(opens in a new tab)';
const A_ATTRS = ' target="_blank" rel="noopener noreferrer nofollow"';

interface Rendered {
  readonly html: string;
  readonly container: HTMLElement;
  readonly removals: readonly Removal[];
}

function md(
  src: string,
  o?: {
    policy?: RenderPolicy;
    vars?: ReadonlyMap<string, string>;
    entity?: string | null;
    headingOffset?: number;
  },
): Rendered {
  const opts: MarkdownOpts =
    o?.headingOffset === undefined
      ? { policy: o?.policy ?? 'board', appOrigin: APP }
      : { policy: o.policy ?? 'board', appOrigin: APP, headingOffset: o.headingOffset };
  const r = renderMarkdown(src, { vars: o?.vars ?? ENV, entity: o?.entity ?? null }, opts);
  const { container } = render(<>{r.node}</>);
  return { html: clean(container.innerHTML), container, removals: r.removals };
}

/** innerHTML with the anchors' fixed attributes dropped, the new-tab spans as `…` and `class=flat`. */
function clean(html: string): string {
  return html
    .split(A_ATTRS)
    .join('')
    .replace(
      new RegExp(
        `<span class="[^"]*" aria-hidden="true"></span><span class="${styles['srOnly'] ?? ''}">\\(opens in a new tab\\)</span>`,
        'g',
      ),
      '…',
    )
    .split(`<span class="${styles['flat'] ?? ''}">`)
    .join('<span class=flat>');
}

const rm = (...xs: [Removal['kind'], number][]): Removal[] =>
  xs.map(([kind, line]) => ({ kind, line }));

/** The deepest element below the container (its children are depth 1). */
function domDepth(root: Element): number {
  let max = 0;
  const stack: [Element, number][] = Array.from(root.children).map((c) => [c, 1]);
  for (let f = stack.pop(); f !== undefined; f = stack.pop()) {
    const [el, d] = f;
    max = Math.max(max, d);
    for (const c of Array.from(el.children)) stack.push([c, d + 1]);
  }
  return max;
}

function flatSpans(c: HTMLElement): string[] {
  return Array.from(c.querySelectorAll(`span.${styles['flat'] ?? 'flat'}`)).map(
    (s) => s.textContent,
  );
}

const P = (n: number): string => '> '.repeat(n);
const Q = P(31);
const E = (k: number): string => '*a '.repeat(k) + 'x' + ' a*'.repeat(k);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('unit:markdown-links', () => {
  it('rejects bad schemes as text and keeps local, external and mailto links (board)', () => {
    expect(md('[a](javascript:x)')).toMatchObject({
      html: '<p>a</p>',
      removals: rm(['linkScheme', 1]),
    });
    expect(md('[t](</\t/e.test>)').html).toBe('<p><a href="/%09/e.test">t…</a></p>');
    expect(md('[b](https://x.test/p)').html).toBe('<p><a href="https://x.test/p">b…</a></p>');
    expect(md('[d](/b)').html).toBe('<p><a href="/b">d…</a></p>');
    expect(md('[e](mailto:o@x.test)').html).toBe('<p><a href="mailto:o@x.test">e…</a></p>');
    for (const s of [
      '<javascript:alert(1)>',
      '[a]\n\n[a]: javascript:x',
      '[a](&#106;avascript:x)',
    ]) {
      const r = md(s);
      expect(r.container.querySelector('a'), s).toBeNull();
      expect(r.removals, s).toEqual(rm(['linkScheme', 1]));
    }
    expect(md('<javascript:alert(1)>').html).toBe('<p>javascript:alert(1)</p>');
    expect(md('[a](/x "t")').html).toBe('<p><a href="/x">a…</a></p>');
  });

  it('a kept anchor has target, rel, the glyph and the hidden text', () => {
    const a = md('[d](/b)').container.querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(a?.getAttribute('title')).toBeNull();
    const [glyph, hidden] = Array.from(a?.querySelectorAll('span') ?? []);
    expect(glyph?.getAttribute('aria-hidden')).toBe('true');
    expect(hidden?.textContent).toBe(NEW_TAB);
    expect(hidden).toHaveClass(styles['srOnly'] ?? 'srOnly');
  });

  it('ai: only local links are anchors; external and mailto become text with host or address', () => {
    const ai = { policy: 'ai' as const };
    expect(md('[b](https://x.test/p)', ai)).toMatchObject({
      html: '<p>b (x.test)</p>',
      removals: [],
    });
    expect(md('[e](mailto:o@x.test)', ai)).toMatchObject({
      html: '<p>e (o@x.test)</p>',
      removals: [],
    });
    expect(md('[d](/b)', ai)).toMatchObject({ html: '<p><a href="/b">d…</a></p>', removals: [] });
    expect(md('[a](javascript:x)', ai)).toMatchObject({
      html: '<p>a</p>',
      removals: rm(['linkScheme', 1]),
    });
  });
});

describe('unit:markdown-nodes', () => {
  it('the T24 §10 inputs', () => {
    expect(md('<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n**ok**')).toMatchObject(
      {
        html: '<p><strong>ok</strong></p>',
        removals: rm(['html', 1], ['html', 3]),
      },
    );
    expect(md('# A\n###### F\n1000000. x').html).toBe(
      '<h4>A</h4><h6>F</h6><ol start="999999"><li>x</li></ol>',
    );
  });

  it('one exact DOM per node row', () => {
    const cases: [string, string][] = [
      ['a', '<p>a</p>'],
      ['## B', '<h5>B</h5>'],
      ['> q', '<blockquote><p>q</p></blockquote>'],
      ['***', '<hr>'],
      ['- a\n- b', '<ul><li>a</li><li>b</li></ul>'],
      ['- a\n\n- b', '<ul><li><p>a</p></li><li><p>b</p></li></ul>'],
      ['1. a', '<ol><li>a</li></ol>'],
      ['3. a', '<ol start="3"><li>a</li></ol>'],
      ['```js x\n$env\n```', '<pre><code data-lang="js">$env\n</code></pre>'],
      ['```JS\nc\n```', '<pre><code>c\n</code></pre>'],
      ['    ind', '<pre><code>ind\n</code></pre>'],
      ['`$env` t', '<p><code>$env</code> t</p>'],
      ['a\nb', '<p>a b</p>'],
      ['a  \nb', '<p>a<br>b</p>'],
      ['*e* **s**', '<p><em>e</em> <strong>s</strong></p>'],
      ['x <b>y</b>', '<p>x y</p>'],
      ['<div>\nz\n</div>', ''],
    ];
    for (const [src, html] of cases) expect(md(src).html, src).toBe(html);
    expect(md('x <b>y</b>').removals).toEqual(rm(['html', 1]));
    expect(md('<div>\nz\n</div>').removals).toEqual(rm(['html', 1]));
  });

  it('heading offset 0 and renderCode', () => {
    expect(md('# A', { headingOffset: 0 }).html).toBe('<h1>A</h1>');
    const { container } = render(<>{renderCode('<b>$env</b>', 'promql')}</>);
    expect(container.innerHTML).toBe(
      '<pre><code data-lang="promql">&lt;b&gt;$env&lt;/b&gt;</code></pre>',
    );
  });
});

describe('unit:markdown-depth', () => {
  it('each pair: elements, then one flat span of the whole lines and one depth', () => {
    const pairs: [string, number, number][] = [
      ['y', 30, 31],
      ['    c', 29, 30],
      ['[a](/b)', 28, 29],
      ['![i](/l.svg)', 29, 30],
      ['![e](https://x.test/e.png)', 28, 29],
      ['![d](data:,x)', 30, 31],
    ];
    for (const [tail, ok, flat] of pairs) {
      const a = md(P(ok) + tail);
      expect(flatSpans(a.container), `${tail} @${String(ok)}`).toEqual([]);
      expect(a.removals.some((r) => r.kind === 'depth')).toBe(false);
      expect(domDepth(a.container)).toBeLessThanOrEqual(MAX_DEPTH);
      const b = md(P(flat) + tail);
      expect(flatSpans(b.container), `${tail} @${String(flat)}`).toEqual([P(flat) + tail]);
      expect(b.removals).toEqual(rm(['depth', 1]));
      expect(domDepth(b.container)).toBeLessThanOrEqual(MAX_DEPTH);
    }
  });

  it('an alt below the limit: one img, the nested image counted', () => {
    const r = md(`${P(29)}![o ![n](/x.svg)](/l.svg)`);
    expect(r.container.querySelectorAll('img')).toHaveLength(1);
    expect(r.container.querySelector('img')?.getAttribute('alt')).toBe('o n');
    expect(r.removals).toEqual(rm(['image', 1]));
  });

  it('two paragraphs, lists, nesting, a link line and an iframe line', () => {
    const two = md(`${Q}p1 $env <b>h</b>\n${Q}\n${Q}[k](/b) p2`);
    expect(flatSpans(two.container)).toEqual([`${Q}p1 $env <b>h</b>\n`, `${Q}[k](/b) p2`]);
    expect(two.removals).toEqual(rm(['depth', 1], ['depth', 3]));
    const whole = [
      `${Q}- a\n${Q}- b [l](/b)`,
      `${Q}- a\n${Q}\n${Q}- b`,
      `${Q}> - x\n${Q}>   - y`,
      `${Q}![i](/l.svg) [a](javascript:x)`,
      `${P(40)}<iframe src="/b"></iframe>`,
    ];
    for (const s of whole) {
      const r = md(s);
      expect(flatSpans(r.container), s).toEqual([s]);
      expect(r.removals, s).toEqual(rm(['depth', 1]));
      expect(domDepth(r.container)).toBeLessThanOrEqual(MAX_DEPTH);
    }
  });
});

describe('unit:markdown-root', () => {
  it('the root fragment holds the top-level blocks; the stack is empty after return', () => {
    const empty = md('');
    expect(empty.html).toBe('');
    expect(empty.removals).toEqual([]);
    expect(memoStats().stackAfterWalk).toBe(0);
    expect(md('a').html).toBe('<p>a</p>');
    expect(memoStats().stackAfterWalk).toBe(0);
    expect(md('a\n\nb').html).toBe('<p>a</p><p>b</p>');
    expect(memoStats().stackAfterWalk).toBe(0);
  });
});

describe('unit:markdown-walk', () => {
  it('unwraps into the immediate parent, in order', () => {
    const cases: [string, string, Removal[]][] = [
      ['x [a](javascript:x) y', '<p>x a y</p>', rm(['linkScheme', 1])],
      ['**s [a](javascript:x) t** u', '<p><strong>s a t</strong> u</p>', rm(['linkScheme', 1])],
      [
        '[a *b* c](javascript:x)\n\n# H\n\n- i',
        '<p>a <em>b</em> c</p><h4>H</h4><ul><li>i</li></ul>',
        rm(['linkScheme', 1]),
      ],
      [
        '> [a](javascript:x)\n\nafter',
        '<blockquote><p>a</p></blockquote><p>after</p>',
        rm(['linkScheme', 1]),
      ],
      [
        '[![i](/l.svg) t](/b)',
        '<p><a href="/b"><img src="/l.svg" alt="i" loading="lazy"> t…</a></p>',
        [],
      ],
      ['[![e](https://x.test/e.png)](/b)', '<p><a href="/b">e…</a></p>', rm(['image', 1])],
      [
        '![a [l](/b) *e* <b>h</b> `c`](/l.svg)',
        '<p><img src="/l.svg" alt="a l e h c" loading="lazy"></p>',
        rm(['html', 1]),
      ],
      [
        '![o ![n](/x.svg)](/l.svg)',
        '<p><img src="/l.svg" alt="o n" loading="lazy"></p>',
        rm(['image', 1]),
      ],
      ['[a <b>h</b> c](/b)', '<p><a href="/b">a h c…</a></p>', rm(['html', 1])],
      ['[a <b>h</b>](javascript:x)', '<p>a h</p>', rm(['linkScheme', 1], ['html', 1])],
      [
        '- x [a](javascript:x) y\n- z\n\nafter',
        '<ul><li>x a y</li><li>z</li></ul><p>after</p>',
        rm(['linkScheme', 1]),
      ],
    ];
    for (const [src, html, removals] of cases) {
      const r = md(src);
      expect(r.html, src).toBe(html);
      expect(r.removals, src).toEqual(removals);
    }
  });

  it('at the limit and past it', () => {
    const at = md(`${P(30)}x [a](javascript:x) y\n\nnext`);
    const quotes = at.container.querySelectorAll('blockquote');
    expect(quotes).toHaveLength(30);
    expect(quotes[29]?.innerHTML).toBe('<p>x a y</p>');
    expect(at.container.lastElementChild?.outerHTML).toBe('<p>next</p>');
    expect(at.removals).toEqual(rm(['linkScheme', 1]));
    const past = md(`${P(31)}x [a](javascript:x) y\n\nnext`);
    expect(flatSpans(past.container)).toEqual([`${P(31)}x [a](javascript:x) y\n`]);
    expect(past.container.lastElementChild?.outerHTML).toBe('<p>next</p>');
    expect(past.removals).toEqual(rm(['depth', 1]));
  });
});

describe('unit:markdown-pathological', () => {
  it('deep, long and unbalanced input completes in time within the depth limit', () => {
    for (const s of [
      '>'.repeat(20000) + 'x',
      '*'.repeat(50000),
      '['.repeat(20000),
      '- '.repeat(5000) + 'x',
    ]) {
      const t0 = performance.now();
      const r = md(s);
      expect(performance.now() - t0, s.slice(0, 8)).toBeLessThan(2000);
      expect(domDepth(r.container)).toBeLessThanOrEqual(MAX_DEPTH);
      if (s.endsWith('x')) expect(r.container.textContent).toContain('x');
    }
    expect(md('['.repeat(20000)).container.textContent).toBe('['.repeat(20000));
  });
});

describe('unit:markdown-flat-lines', () => {
  it('flat spans hold the whole source lines, terminators kept', () => {
    const cases: [string, string][] = [
      [`${Q}-`, `${Q}-`],
      [`${Q}- a\r\n${Q}- b`, `${Q}- a\r\n${Q}- b`],
      [`${Q}- a\r${Q}- b`, `${Q}- a\r${Q}- b`],
      [`${Q}x\ty`, `${Q}x\ty`],
      [`${Q}a\uD800`, `${Q}a�`],
      [`${Q}é漢😀`, `${Q}é漢😀`],
      [`${Q}p`, `${Q}p`],
    ];
    for (const [src, span] of cases) {
      const r = md(src);
      expect(flatSpans(r.container), JSON.stringify(src.slice(62))).toEqual([span]);
      expect(r.removals).toEqual(rm(['depth', 1]));
    }
  });

  it('sourceLines clamps and never throws', () => {
    expect(sourceLines('a\nb\r\nc', 2, 3)).toBe('b\r\nc');
    expect(sourceLines('a\nb\r\nc', 3, 2)).toBe('c');
    expect(sourceLines('a\nb\r\nc', 0, 9)).toBe('a\nb\r\nc');
    expect(sourceLines('a\nb\r\nc', -5, -1)).toBe('a\n');
    expect(sourceLines('a\nb\r\nc', 4, 4)).toBe('c');
    expect(sourceLines('', 1, 1)).toBe('');
  });
});

describe('unit:markdown-inline-depth', () => {
  it('nested emphasis to depth 31, then flat', () => {
    const ok = md(P(10) + E(20));
    expect(ok.container.querySelectorAll('em')).toHaveLength(20);
    expect(domDepth(ok.container)).toBe(31);
    expect(ok.removals).toEqual([]);
    const flat = md(P(10) + E(21));
    expect(flatSpans(flat.container)).toEqual([P(10) + E(21)]);
    expect(flat.removals).toEqual(rm(['depth', 1]));
  });

  it('a kept link with emphasis and an image costs 5', () => {
    const at = md(`${P(26)}[*a ![i](/l.svg)*](/b)`);
    expect(at.container.querySelector('a em img')).not.toBeNull();
    expect(flatSpans(at.container)).toEqual([]);
    const past = md(`${P(27)}[*a ![i](/l.svg)*](/b)`);
    expect(flatSpans(past.container)).toEqual([`${P(27)}[*a ![i](/l.svg)*](/b)`]);
    expect(past.removals).toEqual(rm(['depth', 1]));
  });

  it('E(5000) completes in time within the limit', () => {
    const t0 = performance.now();
    const r = md(E(5000));
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(domDepth(r.container)).toBeLessThanOrEqual(MAX_DEPTH);
    expect(r.removals).toEqual(rm(['depth', 1]));
  });
});

describe('unit:markdown-iframe', () => {
  it('iframes never render and are named', () => {
    const cases: [string, Removal[]][] = [
      ['<iframe src="https://s.test/"></iframe>', rm(['iframe', 1])],
      ['<div>t<iframe src="/b"></iframe></div>', rm(['iframe', 1])],
      [`a <script>'<iframe src="/b">'</script>`, rm(['html', 1])],
      ['- x\n- <iframe src="/b"></iframe>', rm(['iframe', 2])],
    ];
    for (const [src, removals] of cases) {
      const r = md(src);
      expect(r.container.querySelector('iframe'), src).toBeNull();
      expect(r.removals, src).toEqual(removals);
    }
    expect(md('<iframe src="https://s.test/"></iframe>').html).toBe('');
  });
});

describe('unit:markdown-images', () => {
  const I = ['![l](/l.svg)', '![g](https://x.test/g.png)', '![d](data:,x)', '![s](</\t/e.test>)'];

  it('board: local images load, external become links, others alt text', () => {
    expect(I.map((s) => md(s).html)).toEqual([
      '<p><img src="/l.svg" alt="l" loading="lazy"></p>',
      '<p><a href="https://x.test/g.png">g…</a></p>',
      '<p>d</p>',
      '<p><img src="/%09/e.test" alt="s" loading="lazy"></p>',
    ]);
    expect(I.map((s) => md(s).removals)).toEqual([[], rm(['image', 1]), rm(['image', 1]), []]);
  });

  it('ai: alt text and image, never an img', () => {
    for (const [i, s] of I.entries()) {
      const r = md(s, { policy: 'ai' });
      expect(r.html).toBe(`<p>${['l', 'g', 'd', 's'][i] ?? ''}</p>`);
      expect(r.removals).toEqual(rm(['image', 1]));
    }
  });

  it('/api/ and /auth/ images are links; an external image inside a link is its alt text', () => {
    expect(md('![a](/api/x)')).toMatchObject({
      html: '<p><a href="/api/x">a…</a></p>',
      removals: rm(['image', 1]),
    });
    expect(md('![a](/auth/x)')).toMatchObject({
      html: '<p><a href="/auth/x">a…</a></p>',
      removals: rm(['image', 1]),
    });
    expect(md('![a](/%61pi/x)').container.querySelector('img')).toBeNull();
    const nested = md('[![g](https://x.test/g.png)](/b)');
    expect(nested.container.querySelectorAll('a')).toHaveLength(1);
    expect(nested.html).toBe('<p><a href="/b">g…</a></p>');
    expect(nested.removals).toEqual(rm(['image', 1]));
  });
});

describe('unit:markdown-interpolate', () => {
  const V = new Map([
    ['env', 'prod'],
    ['q', 'a b&c'],
    ['u', 'javascript:x'],
  ]);

  it('the T24 §10 V inputs', () => {
    const t = md('Env $env ${env} $missing $__from {{entity}}', { vars: V });
    expect(t.html).toBe('<p>Env prod prod $missing $__from {{entity}}</p>');
    expect(t.removals).toEqual(rm(['unresolved', 1], ['unresolved', 1]));
    expect(md('`$env`', { vars: V }).html).toBe('<p><code>$env</code></p>');
    expect(
      md('[x](https://x.test/?q=$q)', { vars: V })
        .container.querySelector('a')
        ?.getAttribute('href'),
    ).toBe('https://x.test/?q=a%20b%26c');
    expect(md('[y]($u)', { vars: V })).toMatchObject({
      html: '<p>y</p>',
      removals: rm(['linkScheme', 1]),
    });
  });

  it('braced destinations, the entity, values as text', () => {
    expect(md('[z](/b/${env})').container.querySelector('a')?.getAttribute('href')).toBe('/b/prod');
    expect(md('E {{entity}}', { entity: 'svc' }).html).toBe('<p>E svc</p>');
    const x = md('Env $env', { vars: new Map([['env', '<b>x</b>']]) });
    expect(x.html).toBe('<p>Env &lt;b&gt;x&lt;/b&gt;</p>');
    expect(x.container.querySelector('b')).toBeNull();
  });
});

describe('unit:markdown-surrogates', () => {
  it('lone surrogates become U+FFFD in text and %EF%BF%BD in destinations', () => {
    for (const v of ['a\uD800', '\uDC00b']) {
      const vars = new Map([['v', v]]);
      const t = md('Env $v', { vars });
      expect(t.container.textContent).toBe(`Env ${v.replace(/[\uD800-\uDFFF]/, '�')}`);
      const href = md('[a](/b?q=$v)', { vars }).container.querySelector('a')?.getAttribute('href');
      expect(href).toBe(v === 'a\uD800' ? '/b?q=a%EF%BF%BD' : '/b?q=%EF%BF%BDb');
    }
    expect(
      md('[a](/b?q={{entity}})', { entity: '\uD800' })
        .container.querySelector('a')
        ?.getAttribute('href'),
    ).toBe('/b?q=%EF%BF%BD');
    const lone = md('x\uDC00y [a](/b\uDC00)');
    expect(lone.container.textContent).toContain('x�y');
    expect(lone.container.querySelector('a')?.getAttribute('href')).toBe('/b%EF%BF%BD');
    const wf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(wf.test(lone.container.innerHTML)).toBe(false);
  });
});

describe('unit:removal-redaction', () => {
  const SECRET = "[x](javascript:fetch('https://u:hunter2@e.test/?token=abc'))";
  const HTML = '<a href="https://e.test/?token=abc">';

  it('removals, messages and the log carry no content', () => {
    const a = md(SECRET);
    const b = md(HTML);
    expect(a.removals).toEqual(rm(['linkScheme', 1]));
    expect(b.removals).toEqual(rm(['html', 1]));
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    logRemovals('p1', a.removals);
    logRemovals('p2', b.removals);
    const text = [
      ...[...a.removals, ...b.removals].map(removalMessage),
      ...debug.mock.calls.map((c) => JSON.stringify(c)),
    ].join('\n');
    expect(debug).toHaveBeenCalledTimes(2);
    for (const s of ['hunter2', 'token', 'e.test']) expect(text).not.toContain(s);
    expect(removalMessage({ kind: 'linkScheme', line: 1 })).toBe(
      'Line 1: a link with an unsupported address is shown as text.',
    );
    expect(removalMessage({ kind: 'iframe', line: 4 })).toBe(
      'Embedded page not shown (line 4): add a link.',
    );
    expect(removalMessage({ kind: 'depth', line: 2 })).toBe(
      'Line 2: deeply nested content is shown as plain text.',
    );
  });

  it('logRemovals logs once per distinct non-empty result', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined);
    logRemovals('q1', rm(['html', 1]));
    logRemovals('q1', rm(['html', 1]));
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenLastCalledWith({ panelId: 'q1', removals: rm(['html', 1]) });
    logRemovals('q1', rm(['html', 2]));
    expect(debug).toHaveBeenCalledTimes(2);
    logRemovals('q2', []);
    expect(debug).toHaveBeenCalledTimes(2);
  });
});
