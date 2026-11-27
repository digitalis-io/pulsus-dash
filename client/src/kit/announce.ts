/**
 * A polite announcer (T08-018; plan #234 Part 3 §2). Stub (tests first).
 */
export interface PoliteAnnouncer {
  /** The live region's text. */
  readonly text: string;
  announce(text: string): void;
}

export function usePoliteAnnouncer(): PoliteAnnouncer {
  return { text: '', announce: () => undefined };
}
