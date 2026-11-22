/**
 * Makes the page outside a non-modal overlay inert (plan #63 Part C C.11.1). React Aria's ComboBox
 * hides everything outside its input and list with `aria-hidden` only, which leaves those regions
 * focusable (axe `aria-hidden-focus`); `inert` on the same regions removes them from focus and
 * pointer input as well, as React Aria does for the app's modal popovers.
 */

/** Nodes React Aria always keeps visible (live announcer, toasts). */
export const ALWAYS_LIVE = '[data-live-announcer], [data-react-aria-top-layer]';

/**
 * Sets `inert` on every element under `root` that neither matches nor contains `keep` (or
 * ALWAYS_LIVE); elements added under `root` later are handled the same way. Returns an
 * idempotent release that removes `inert` only where this call set it, and stops observing.
 */
export function inertOutside(keep: string, root: Element = document.body): () => void {
  const sel = `${keep}, ${ALWAYS_LIVE}`;
  const set: Element[] = [];
  const mark = (el: Element): void => {
    if (el.hasAttribute('inert')) return;
    el.setAttribute('inert', '');
    set.push(el);
  };
  const visit = (parent: Element): void => {
    for (const c of Array.from(parent.children)) {
      if (c.matches(sel)) continue;
      if (c.querySelector(sel) !== null) visit(c);
      else mark(c);
    }
  };
  visit(root);
  const mo = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of Array.from(r.addedNodes)) {
        if (!(n instanceof Element) || !n.isConnected) continue;
        if (n.closest('[inert]') !== null || n.closest(sel) !== null) continue;
        if (n.querySelector(sel) !== null) visit(n);
        else mark(n);
      }
    }
  });
  mo.observe(root, { childList: true, subtree: true });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    mo.disconnect();
    for (const el of set) el.removeAttribute('inert');
    set.length = 0;
  };
}
