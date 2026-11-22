import { describe, expect, it } from 'vitest';
import { LANGUAGES, LanguageUnavailableError } from './index';
import { promql } from './promql/promql';

// ADR-0018: a static table from language id to a lazy import of its QueryLanguage.
describe('unit:lang-table', () => {
  it('PromQL loads its module; the languages not built yet reject', async () => {
    expect(await LANGUAGES.promql()).toBe(promql);
    expect((await LANGUAGES.promql()).lang).toBe('promql');
    for (const id of ['logql', 'traceql', 'profile'] as const) {
      const e: unknown = await LANGUAGES[id]().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LanguageUnavailableError);
      expect((e as LanguageUnavailableError).lang).toBe(id);
    }
  });
});
