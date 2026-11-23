/** PromQL completion (plan #107 §3.3). Stubs for the tests-first commit. */
import type { CompletionSection } from '@codemirror/autocomplete';

export const LOCAL_SECTION: CompletionSection = { name: 'local', rank: 0 };
export const REMOTE_SECTION: CompletionSection = { name: 'remote', rank: 1 };
