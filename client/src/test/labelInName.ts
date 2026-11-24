/**
 * WCAG 2.5.3 (label in name), strict. For every widget with a name from content that has an
 * aria-label or aria-labelledby and shows text, the visible text's words must appear, in order and
 * contiguous, in the accessible name. The name is axe-core's (axe.commons.text.accessibleText).
 * Unlike axe's rule, it does not skip single letters or "aa"/"abc".
 * Needs axe-core on globalThis.axe: injected by AxeBuilder in e2e, set by the unit test.
 * Self-contained: no imports and no module-level references (page.evaluate serializes it).
 * Returns one entry per mismatch: `label-in-name: <tag> "<visible>" not in "<name>"`.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- stub (tests first)
export function scanLabelInName(root: ParentNode = document.body): string[] {
  return [];
}
