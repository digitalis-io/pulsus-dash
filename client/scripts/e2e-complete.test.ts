import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkE2eComplete } from './e2e-complete.ts';
import { InputError } from './lib/report.ts';

type Status = 'expected' | 'unexpected' | 'flaky' | 'skipped';
interface T {
  file: string;
  path: string[];
  project?: string;
  status?: Status;
  results?: number;
}

/** A JSON report (the shape of Playwright's json reporter) of `tests`, grouped by file. */
function report(tests: readonly T[]): unknown {
  const files = [...new Set(tests.map((t) => t.file))];
  return {
    suites: files.map((file) => {
      const root = { title: file, file, specs: [] as unknown[], suites: [] as unknown[] };
      for (const t of tests.filter((x) => x.file === file)) {
        let at: { title: string; file: string; specs: unknown[]; suites: unknown[] } = root;
        for (const d of t.path.slice(0, -1)) {
          let next = (at.suites as (typeof root)[]).find((s) => s.title === d);
          if (next === undefined) {
            next = { title: d, file, specs: [], suites: [] };
            at.suites.push(next);
          }
          at = next;
        }
        const status = t.status ?? 'expected';
        at.specs.push({
          title: t.path.at(-1),
          file,
          tests: [
            {
              projectName: t.project ?? 'firefox',
              status,
              results: Array.from({ length: t.results ?? 1 }, () => ({
                status:
                  status === 'expected' ? 'passed' : status === 'skipped' ? 'skipped' : 'failed',
              })),
            },
          ],
        });
      }
      return root;
    }),
  };
}

const FOUR: T[] = [
  { file: 'a.spec.ts', path: ['A', 'one'] },
  { file: 'a.spec.ts', path: ['A', 'inner', 'two'] },
  { file: 'b.spec.ts', path: ['three'] },
  { file: 'b.spec.ts', path: ['B', 'four'] },
];
/** Firefox's one allowed skip (config/e2eSkips.ts): listed, and skipped in `rest`. */
const E6T: T = {
  file: 'log-stream.spec.ts',
  path: ['e2e:log-stream', 'E6 touch: no scroll write during the gesture'],
  status: 'skipped',
};
const listed = (tests: readonly T[]) =>
  report([...tests, E6T].map((t) => ({ ...t, status: 'expected' as const, results: 0 })));
const withE6 = ([name, tests]: [string, T[]]): { name: string; report: unknown } => ({
  name,
  report: report(name === 'rest' ? [...tests, E6T] : tests),
});
const ids = (l: unknown, shards: [string, T[]][]): string[] =>
  checkE2eComplete(l, shards.map(withE6), 'firefox').map((f) => `${f.rule} ${f.subject ?? ''}`);

const REAL = JSON.parse(
  readFileSync(
    new URL('./__fixtures__/e2e-complete/firefox-log-stream.json', import.meta.url),
    'utf8',
  ),
) as unknown;
const E6 = 'log-stream.spec.ts › e2e:log-stream › E6 touch: no scroll write during the gesture';
/** The real firefox report, with every test's project or E6's status replaced. */
function realAs(o: { project?: string; e6?: Status }): unknown {
  return JSON.parse(JSON.stringify(REAL), function (this: Record<string, unknown>, k, v: unknown) {
    if (k === 'projectName' && o.project !== undefined) return o.project;
    if (k === 'tests' && this['title'] === E6.split(' › ').at(-1) && o.e6 !== undefined) {
      return (v as Record<string, unknown>[]).map((t) => ({ ...t, status: o.e6 }));
    }
    return v;
  }) as unknown;
}

describe('ci:e2e-complete (#130, T05-002)', () => {
  it('complete run passes', () => {
    const [a1, a2, b1, b2] = FOUR as [T, T, T, T];
    expect(
      ids(listed(FOUR), [
        ['kbd-a', [a1]],
        ['kbd-b', [{ ...a2, status: 'flaky', results: 2 }]],
        ['rest', [b1]],
        ['rest-b', [b2]],
      ]),
    ).toEqual([]);
  });

  it('missing and not-run tests', () => {
    const [a1, , b1, b2] = FOUR as [T, T, T, T];
    expect(
      ids(listed(FOUR), [
        ['kbd-a', [a1]],
        ['rest', [b1, { ...b2, results: 0 }]],
      ]),
    ).toEqual([
      'e2e-test-missing a.spec.ts › A › inner › two [firefox]',
      'e2e-test-not-run b.spec.ts › B › four [firefox]',
    ]);
  });

  it('test in two shards', () => {
    const [a1, a2, b1, b2] = FOUR as [T, T, T, T];
    const f = checkE2eComplete(
      listed(FOUR),
      (
        [
          ['kbd-a', [a1, a2]],
          ['kbd-b', []],
          ['rest', [b1]],
          ['rest-b', [b1, b2]],
        ] as [string, T[]][]
      ).map(withE6),
      'firefox',
    );
    expect(f.map((x) => `${x.rule} ${x.subject ?? ''}`)).toEqual([
      'e2e-test-duplicate b.spec.ts › three [firefox]',
    ]);
    expect(f[0]?.message).toContain('rest, rest-b');
  });

  it('unintended skip fails', () => {
    const t: T = { file: 'board-edit.spec.ts', path: ['edit', 'saves'] };
    expect(ids(listed([t]), [['rest', [{ ...t, status: 'skipped' }]]])).toEqual([
      'e2e-test-skipped board-edit.spec.ts › edit › saves [firefox]',
    ]);
  });

  it('allowed skip passes only where allowed', () => {
    const one = (r: unknown, project: string) =>
      checkE2eComplete(r, [{ name: 'rest', report: r }], project).map(
        (f) => `${f.rule} ${f.subject ?? ''}`,
      );
    expect(one(REAL, 'firefox')).toEqual([]);
    expect(one(realAs({ project: 'chromium' }), 'chromium')).toEqual([
      `e2e-test-skipped ${E6} [chromium]`,
    ]);
    expect(one(realAs({ e6: 'expected' }), 'firefox')).toEqual([`e2e-skip-unused ${E6} [firefox]`]);
  });

  it('failed, unexpected; other project ignored', () => {
    const [a1, a2, b1, b2] = FOUR as [T, T, T, T];
    expect(
      ids(listed([...FOUR, { ...a1, project: 'webkit' }]), [
        [
          'kbd-a',
          [
            { ...a1, status: 'unexpected' },
            { ...a1, project: 'webkit', results: 0 },
          ],
        ],
        ['kbd-b', [a2, { file: 'c.spec.ts', path: ['extra'] }]],
        ['rest', [b1, b2]],
      ]),
    ).toEqual([
      'e2e-test-failed a.spec.ts › A › one [firefox]',
      'e2e-test-unexpected c.spec.ts › extra [firefox]',
    ]);
  });

  it('empty input is exit 2', () => {
    expect(() =>
      checkE2eComplete(report([]), [{ name: 'rest', report: report(FOUR) }], 'firefox'),
    ).toThrow(InputError);
    expect(() => checkE2eComplete(listed(FOUR), [], 'firefox')).toThrow(InputError);
  });
});
