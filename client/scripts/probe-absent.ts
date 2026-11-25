/**
 * `ci:probe-absent` (T03-024, plan #68 C1 §2, §5.1). Every file of a dist tree, recursively
 * (chunks, worker bundles, the `.wasm`, everything else), is scanned for the probe global
 * `__dashProbe` and the fault sentinel `__pulsus_engine_fault__` (each fault site's
 * `__pulsus_engine_fault__:<route|boot|worker>`, `src/engine/faults.ts`): each hit in a release
 * tree is one `probe-in-release` finding. With `--expect-faults` the tree is a fault build and
 * must contain all three site sentinels instead: each missing site is one `fault-site-missing`.
 *
 * Usage: node scripts/probe-absent.ts [--expect-faults] <dist>
 * Exit: 0 none, 1 findings, 2 `dist` unreadable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { InputError, runCli, type Finding } from './lib/report.ts';

/** Joined here so this file is not a hit. */
const SENTINEL = ['__pulsus_engine', 'fault__'].join('_');
const HOOKS = ['__dashProbe', SENTINEL].map((h) => Buffer.from(h));
export const FAULT_SITES = ['route', 'boot', 'worker'] as const;

function files(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, root, out);
    else out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

function tree(dist: string): string[] {
  try {
    if (!statSync(dist).isDirectory()) throw new Error();
    return files(dist).sort();
  } catch {
    throw new InputError(`cannot read ${dist}`);
  }
}

export function checkProbeAbsent(dist: string, o: { expectFaults?: boolean } = {}): Finding[] {
  const list = tree(dist);
  const findings: Finding[] = [];
  if (o.expectFaults === true) {
    const seen = new Set<string>();
    for (const f of list) {
      const text = readFileSync(join(dist, f)).toString('latin1');
      for (const site of FAULT_SITES) if (text.includes(`${SENTINEL}:${site}`)) seen.add(site);
    }
    for (const site of FAULT_SITES.filter((s) => !seen.has(s))) {
      findings.push({
        rule: 'fault-site-missing',
        file: dist,
        subject: site,
        message: `the fault build has no ${SENTINEL}:${site}`,
      });
    }
    return findings;
  }
  for (const f of list) {
    const bytes = readFileSync(join(dist, f));
    const hook = HOOKS.find((h) => bytes.includes(h));
    if (hook !== undefined) {
      findings.push({
        rule: 'probe-in-release',
        file: f,
        subject: hook.toString(),
        message: `${hook.toString()} is in a release build (T03-024)`,
      });
    }
  }
  return findings;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const expectFaults = args.includes('--expect-faults');
  const dist = args.find((a) => !a.startsWith('--'));
  void runCli(() => {
    if (dist === undefined) {
      throw new InputError('usage: node scripts/probe-absent.ts [--expect-faults] <dist>');
    }
    return checkProbeAbsent(dist, { expectFaults });
  });
}
