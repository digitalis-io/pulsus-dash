/**
 * `ci:geo-data` (T24-087, T24 §5.13; plan #231 §5): each asset of `tools/geo/manifest.json` has the
 * manifest's SHA-256 and byte length, and decodes (`src/vis/geo/decode.ts`, the client's own
 * validator). The pinned sources are never read here: `make geo-check` rebuilds from them.
 *
 * Usage: node scripts/check-geo-data.ts [repository root]
 * Exit: 0 no findings, 1 findings (`sha256-mismatch`, `invalid-asset`), 2 the manifest or an asset
 * is missing or unreadable.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBasemap, decodeGazetteer } from '../src/vis/geo/decode.ts';
import { InputError, readJson, record, report, type Finding } from './lib/report.ts';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = 'tools/geo/manifest.json';
const DECODERS: Readonly<Record<string, (j: unknown) => unknown>> = {
  'client/src/vis/geo/data/basemap.json': decodeBasemap,
  'client/src/vis/geo/data/gazetteer.json': decodeGazetteer,
};

interface Asset {
  file: string;
  sha256: string;
  bytes: number;
}

function parseManifest(v: unknown): Asset[] {
  const assets = record(v, MANIFEST)['assets'];
  if (!Array.isArray(assets)) throw new InputError(`${MANIFEST} has no assets list`);
  const out = assets.map((a: unknown, i) => {
    const r = record(a, `${MANIFEST} assets[${String(i)}]`);
    const { file, sha256, bytes } = r;
    if (typeof file !== 'string' || typeof sha256 !== 'string' || typeof bytes !== 'number') {
      throw new InputError(`${MANIFEST} assets[${String(i)}] needs file, sha256 and bytes`);
    }
    return { file, sha256, bytes };
  });
  const files = out.map((a) => a.file).sort();
  if (files.join('\n') !== Object.keys(DECODERS).sort().join('\n')) {
    throw new InputError(`${MANIFEST} must list exactly ${Object.keys(DECODERS).join(' and ')}`);
  }
  return out;
}

/** The findings for the assets under `root` (the repository root). */
export function checkGeoData(root: string): Finding[] {
  const findings: Finding[] = [];
  for (const a of parseManifest(readJson(join(root, MANIFEST)))) {
    let data: Buffer;
    try {
      data = readFileSync(join(root, a.file));
    } catch {
      throw new InputError(`cannot read ${a.file}`);
    }
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== a.sha256 || data.length !== a.bytes) {
      findings.push({
        rule: 'sha256-mismatch',
        file: a.file,
        subject: a.file,
        message: `SHA-256 ${digest} (${String(data.length)} bytes); the manifest has ${a.sha256} (${String(a.bytes)} bytes)`,
      });
      continue;
    }
    let json: unknown = null;
    try {
      json = JSON.parse(data.toString('utf8')) as unknown;
    } catch {
      json = null;
    }
    if (DECODERS[a.file]?.(json) == null) {
      findings.push({
        rule: 'invalid-asset',
        file: a.file,
        subject: a.file,
        message: 'the asset does not validate (T24-087)',
      });
    }
  }
  return findings;
}

export function main(argv: readonly string[]): number {
  let findings: Finding[];
  try {
    findings = checkGeoData(argv[0] ?? REPO_ROOT);
  } catch (e) {
    console.error(`error[input] ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
  const code = report(findings);
  if (code === 0) console.log('geo-data: 2 assets match the manifest and decode');
  return code;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
