/**
 * Writes the engine parity fixtures `engine/fixtures/*.json` (plan #68 §3.14, A.7) from the TS
 * sources of truth. `--write` writes them; without it the committed files are compared.
 */
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_DIR = join(fileURLToPath(new URL('..', import.meta.url)), '..', 'engine', 'fixtures');

/** Every fixture file name → its JSON text. */
export function fixtures(): Promise<Record<string, string>> {
  return Promise.resolve({});
}
