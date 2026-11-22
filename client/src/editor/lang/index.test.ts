import { describe, expect, it } from 'vitest';
import { LANGUAGES, LanguageUnavailableError } from './index';
import { logql } from './logql/logql';
import { promql } from './promql/promql';
import { UNKNOWN_SHAPE } from './types';

// ADR-0018: a static table from language id to a lazy import of its QueryLanguage.
describe('unit:lang-table', () => {
  it('PromQL and LogQL load their modules; the languages not built yet reject', async () => {
    expect(await LANGUAGES.promql()).toBe(promql);
    expect((await LANGUAGES.promql()).lang).toBe('promql');
    for (const id of ['traceql', 'profile'] as const) {
      const e: unknown = await LANGUAGES[id]().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(LanguageUnavailableError);
      expect((e as LanguageUnavailableError).lang).toBe(id);
    }
  });

  it('LogQL: its shape claims nothing (ADR-0021 §4) and it detects nothing yet', async () => {
    const l = await LANGUAGES.logql().catch((x: unknown) => x);
    expect(l).toBe(logql);
    expect(logql.lang).toBe('logql');
    expect(logql.shape('{a="b"}')).toBe(UNKNOWN_SHAPE);
    expect(logql.shape('rate({a="b"}[1m])')).toBe(UNKNOWN_SHAPE);
    expect(logql.detect('{app=')).toBe(0);
  });
});
