/** Stub (tests first, plan #216 Part 2a). */
export const ANNOUNCE_GAP_MS = 0;

export function useListAnnouncer(): { text: string; announce(s: string): void } {
  return { text: '', announce: () => undefined };
}
