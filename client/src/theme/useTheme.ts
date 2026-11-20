// Stub for the tests-first commit: the implementation follows.
import { type ResolvedTheme, type ThemePref } from './theme';

export function useTheme(): {
  pref: ThemePref;
  resolved: ResolvedTheme;
  setPref: (p: ThemePref) => void;
} {
  throw new Error('not implemented');
}
