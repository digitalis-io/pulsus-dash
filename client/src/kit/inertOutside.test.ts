import { afterEach, describe, expect, it } from 'vitest';
import { inertOutside } from './inertOutside';

const inert = (sel: string): boolean => document.querySelector(sel)?.hasAttribute('inert') ?? false;
const microtask = () =>
  new Promise<void>((r) => {
    queueMicrotask(r);
  });

/** `tag#id[attr…]` with children. */
function el(tag: string, attrs: Record<string, string>, ...kids: Element[]): Element {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('inertOutside', () => {
  it('inerts the outside, follows additions and releases only its own', async () => {
    document.body.append(
      el(
        'div',
        { id: 'app' },
        el('header', {}, el('div', { 'data-k': '' }, el('input', { id: 'in' }))),
        el('button', { id: 'run' }),
      ),
      el('main', {}, el('button', { id: 'x' })),
      el('div', { id: 'pop', 'data-p': '' }, el('ul', {})),
      el('div', { id: 'live', 'data-live-announcer': '' }),
      el('div', { id: 'pre', inert: '' }),
    );
    const r = inertOutside('[data-k], [data-p]');
    expect(inert('#run')).toBe(true);
    expect(inert('main')).toBe(true);
    for (const s of ['#app', 'header', '[data-k]', '#pop', '#live'])
      expect(inert(s), s).toBe(false);

    const late = document.createElement('button');
    late.id = 'late';
    document.querySelector('#app')?.append(late);
    await microtask();
    expect(inert('#late')).toBe(true);
    const li = document.createElement('li');
    document.querySelector('#pop ul')?.append(li);
    await microtask();
    expect(li.hasAttribute('inert')).toBe(false);

    r();
    expect([...document.querySelectorAll('[inert]')].map((e) => e.id)).toEqual(['pre']);
    r();
    expect([...document.querySelectorAll('[inert]')].map((e) => e.id)).toEqual(['pre']);
    const after = document.createElement('button');
    after.id = 'after';
    document.querySelector('#app')?.append(after);
    await microtask();
    expect(inert('#after')).toBe(false);
  });
});
