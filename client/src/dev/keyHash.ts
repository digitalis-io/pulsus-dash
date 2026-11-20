/**
 * A development stand-in for the BFF's `key_hash` (T04-004): FNV-1a 64 over the canonical label
 * text, as 16 lower-case hex digits. Production keys come from `SeriesFrame.key`; this is only used
 * by the gallery's synthetic data.
 */
const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** Keys sorted, `k="v"` joined by `,`. */
export function canonicalLabels(l: Readonly<Record<string, string>>): string {
  return Object.keys(l)
    .sort()
    .map((k) => `${k}="${l[k] ?? ''}"`)
    .join(',');
}

export function keyHash(l: Readonly<Record<string, string>>): string {
  let h = OFFSET;
  for (const byte of new TextEncoder().encode(canonicalLabels(l))) {
    h ^= BigInt(byte);
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}
