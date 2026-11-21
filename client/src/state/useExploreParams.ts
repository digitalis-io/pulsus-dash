/** Stub (tests first, plan #63 §5). */
import { DEFAULT_EXPLORE, type ExploreParams } from './exploreParams';

export function useExploreParams(): {
  readonly params: ExploreParams;
  set(p: Partial<ExploreParams>, o: { readonly replace: boolean }): void;
} {
  return {
    params: DEFAULT_EXPLORE,
    set: () => undefined,
  };
}
