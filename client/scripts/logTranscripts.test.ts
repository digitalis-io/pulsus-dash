// unit:log-transcripts (plan #66 Part C §3.13, §5.1): the generated paging transcripts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { END_S, L0_S, pagingTranscripts, TRANSCRIPT_DIR } from './logTranscripts.ts';

interface Transcript {
  response: { body: { data: { result: { values: [string, string, unknown][] }[] } } };
}

describe('unit:log-transcripts', () => {
  it('the committed files equal a fresh run, byte for byte', () => {
    const ts = pagingTranscripts();
    expect(ts.map((t) => t.file)).toEqual(['logs-paging-1.json', 'logs-paging-2.json']);
    for (const t of ts) {
      expect(readFileSync(join(TRANSCRIPT_DIR, t.file), 'utf8'), t.file).toBe(t.text);
    }
  });

  it('page one has 1 001 entries, page two 500, entry 1 000 in both, all distinct in the window', () => {
    const [one, two] = pagingTranscripts().map(
      (t) => (JSON.parse(t.text) as Transcript).response.body.data.result[0]?.values ?? [],
    );
    expect(one).toHaveLength(1001);
    expect(two).toHaveLength(500);
    expect(one?.at(-1)).toEqual(two?.[0]);
    expect(one?.at(-1)?.[1]).toBe('paging line 1000');
    const lo = BigInt(L0_S) * 1000000000n;
    const hi = BigInt(END_S) * 1000000000n;
    const all = [...(one ?? []), ...(two ?? []).slice(1)].map(([ts]) => BigInt(ts));
    expect(all).toHaveLength(1500);
    expect(new Set(all).size).toBe(1500);
    expect(all.every((t) => t > lo && t <= hi)).toBe(true);
  });
});
