export const E2E_SHARDS = ['kbd-a', 'kbd-b', 'rest'] as const;

export interface ShardFilter {
  grep?: RegExp;
  grepInvert?: RegExp;
}

// Stub (tests first, #130).
export function shardFilter(_name: string | undefined): ShardFilter {
  return {};
}
