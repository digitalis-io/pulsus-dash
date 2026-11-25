/**
 * `ci:probe-absent` (T03-024, plan #68 C1 §5.1): no test hook in a release build. Every `.js` and
 * `.wasm` file of `dist/` is scanned for the probe global `__dashProbe` and the fault module's
 * sentinel (`src/engine/wasm/faults.ts`), which a release build drops; each hit is one
 * `probe-in-release` finding.
 *
 * Usage: node scripts/probe-absent.ts <dist>
 * Exit: 0 none, 1 findings, 2 `dist` unreadable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { InputError, runCli, type Finding } from './lib/report.ts';

/** The hooks, as bytes (the fault sentinel is split here so this file is not a hit). */
const HOOKS = ['__dashProbe', ['__pulsus_engine', 'fault__'].join('_')].map((h) => Buffer.from(h));

function files(dir: string, root = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, root, out);
    else if (/\.(js|mjs|wasm)$/.test(e.name)) out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

export function checkProbeAbsent(dist: string): Finding[] {
  let list: string[];
  try {
    if (!statSync(dist).isDirectory()) throw new Error();
    list = files(dist).sort();
  } catch {
    throw new InputError(`cannot read ${dist}`);
  }
  const findings: Finding[] = [];
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
  const dist = process.argv[2];
  void runCli(() => {
    if (dist === undefined) throw new InputError('usage: node scripts/probe-absent.ts <dist>');
    return checkProbeAbsent(dist);
  });
}
