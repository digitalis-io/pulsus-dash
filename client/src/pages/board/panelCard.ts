/** The board's card of a panel, which its editor zooms open from and closes back to (#282). */
export function panelCard(root: ParentNode, panelId: string): HTMLElement | null {
  // `CSS.escape` is not used: jsdom lacks it.
  return (
    [...root.querySelectorAll<HTMLElement>('[data-panel]')].find(
      (p) => p.dataset['panel'] === panelId,
    ) ?? null
  );
}
