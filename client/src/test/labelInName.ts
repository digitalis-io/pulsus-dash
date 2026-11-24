/**
 * WCAG 2.5.3 (label in name), strict. For every widget with a name from content that has an
 * aria-label or aria-labelledby and shows text, the visible text's words must appear, in order and
 * contiguous, in the accessible name. The name is axe-core's (axe.commons.text.accessibleText).
 * Unlike axe's rule, it does not skip single letters or "aa"/"abc".
 * Needs axe-core on globalThis.axe: injected by AxeBuilder in e2e, set by the unit test.
 * Self-contained: no imports and no module-level references (page.evaluate serializes it).
 * Returns one entry per mismatch: `label-in-name: <tag> "<visible>" not in "<name>"`.
 */
export function scanLabelInName(root: ParentNode = document.body): string[] {
  const axe = (globalThis as unknown as { axe?: typeof import('axe-core') }).axe;
  if (axe === undefined) return ['label-in-name: axe-core not loaded'];

  const ROLES = new Set([
    'button',
    'link',
    'menuitem',
    'menuitemradio',
    'menuitemcheckbox',
    'tab',
    'option',
    'checkbox',
    'switch',
    'radio',
    'treeitem',
  ]);
  const SKIP_TAGS = new Set(['svg', 'script', 'style', 'template']);

  const roleOf = (el: Element): string => {
    const attr = el.getAttribute('role');
    if (attr !== null && attr.trim() !== '') return attr.trim().split(/\s+/)[0] ?? '';
    const tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    return '';
  };
  const hiddenSelf = (el: Element): boolean => {
    if (el.hasAttribute('hidden')) return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden';
  };
  const hidden = (el: Element): boolean => {
    for (let e: Element | null = el; e !== null; e = e.parentElement) {
      if (hiddenSelf(e)) return true;
      if (e === document.documentElement) break;
    }
    return false;
  };
  const visibleText = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    if (SKIP_TAGS.has(node.tagName.toLowerCase())) return '';
    if (hiddenSelf(node) || getComputedStyle(node).clipPath === 'inset(50%)') return '';
    let text = '';
    for (const c of node.childNodes) text += visibleText(c);
    return text;
  };
  const tokens = (s: string): string[] =>
    s
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()
      .split(' ')
      .filter((w) => w !== '');
  const contains = (hay: readonly string[], needle: readonly string[]): boolean => {
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (needle.every((w, k) => hay[i + k] === w)) return true;
    }
    return false;
  };

  const out: string[] = [];
  axe.setup(document);
  try {
    for (const el of root.querySelectorAll('button, a[href], [role]')) {
      const role = roleOf(el);
      if (!ROLES.has(role) || hidden(el)) continue;
      const labelled =
        (el.getAttribute('aria-label') ?? '').trim() !== '' ||
        (el.getAttribute('aria-labelledby') ?? '').trim() !== '';
      if (!labelled) continue;
      const name = axe.commons.text.accessibleText(el).trim();
      if (name === '') continue;
      const visible = visibleText(el);
      const seen = tokens(visible);
      if (seen.length === 0 || contains(tokens(name), seen)) continue;
      const attr = el.getAttribute('role');
      const tag = el.tagName.toLowerCase() + (attr === null ? '' : `[role=${attr}]`);
      out.push(`label-in-name: ${tag} "${visible.trim()}" not in "${name}"`);
    }
  } finally {
    axe.teardown();
  }
  return out;
}
