/**
 * Builds an editor view the way `PromQLEditor` mounts it (plan #63 Part B §5): a host on
 * `document.body`, an open shadow root, a mount `<div>` in it. `destroyViews()` after each test.
 */
import type { EditorView } from '@codemirror/view';
import { vi } from 'vitest';
import type { PromSource } from '../editor/lang/types';
import { createPromQLView } from '../editor/view';
import './editorDom';
import { F, fakePromSource } from './fakePromSource';

export interface ViewInOptions {
  readonly doc: string;
  /** The caret; default the end of `doc`. */
  readonly caret?: number;
  readonly source?: PromSource;
  readonly label?: string;
  readonly placeholder?: string;
  readonly onChange?: (text: string) => void;
  readonly onRun?: () => void;
  readonly onEscape?: () => void;
}

export interface ViewIn {
  readonly view: EditorView;
  readonly host: HTMLElement;
  readonly root: ShadowRoot;
}

const live: ViewIn[] = [];

export function viewIn(o: ViewInOptions): ViewIn {
  const host = document.createElement('div');
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' });
  const mount = document.createElement('div');
  root.append(mount);
  const view = createPromQLView({
    parent: mount,
    root,
    doc: o.doc,
    label: o.label ?? 'PromQL query',
    placeholder: o.placeholder ?? '',
    source: o.source ?? fakePromSource(F),
    onChange: o.onChange ?? vi.fn(),
    onRun: o.onRun ?? vi.fn(),
    onEscape: o.onEscape ?? vi.fn(),
  });
  view.dispatch({ selection: { anchor: o.caret ?? o.doc.length } });
  const v = { view, host, root };
  live.push(v);
  return v;
}

/** Destroys every view `viewIn` made and removes its host. */
export function destroyViews(): void {
  for (const v of live.splice(0)) {
    v.view.destroy();
    v.host.remove();
  }
}

/** A keydown through the editor's keymaps, as CodeMirror's own handler runs them. */
export function key(init: KeyboardEventInit): KeyboardEvent {
  return new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
}

/** Real-time wait (the completion debounce and interaction delays are timers). */
export function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One macrotask: every pending microtask has run. */
export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
