/** The body widths of a board's panels, shared by a panel and its editor preview (plan #64 §3.4). */

export interface WidthStore {
  get(id: string): number | null;
  set(id: string, w: number | null): void;
  subscribe(cb: () => void): () => void;
}

export function createWidthStore(): WidthStore {
  throw new Error('not implemented');
}

export function usePanelWidth(_id: string): number | null {
  return null;
}
