/**
 * The engine's workers and its Trusted Types policy (plan #68 C1 §3.5, ADR-0026). `new Worker` is
 * a Trusted Types sink under `require-trusted-types-for 'script'`, so the worker URLs go through
 * the `pulsus-engine` policy, which admits exactly the render and pool worker scripts of this
 * build and throws for anything else. This is the only module that creates a policy. Without
 * Trusted Types the URL is used as it is.
 */
import { POOL_URL, RENDER_URL } from './workerUrls';

interface Policy {
  createScriptURL(u: string): unknown;
}

interface TrustedTypesLike {
  createPolicy(name: string, rules: { createScriptURL(u: string): string }): Policy;
}

let policy: Policy | null | undefined;

function base(): string {
  return location.href;
}

/** `u` iff it is one of the two engine worker scripts. */
function admit(u: string): string {
  const href = new URL(u, base()).href;
  const allowed = [RENDER_URL, POOL_URL].map((w) => new URL(w, base()).href);
  if (!allowed.includes(href)) throw new TypeError('pulsus-engine: not an engine worker script');
  return u;
}

function enginePolicy(): Policy | null {
  if (policy !== undefined) return policy;
  const tt = (globalThis as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  policy = tt === undefined ? null : tt.createPolicy('pulsus-engine', { createScriptURL: admit });
  return policy;
}

/** A worker script URL for `new Worker`: trusted when Trusted Types are on. */
export function scriptUrl(u: string): string {
  const p = enginePolicy();
  // A TrustedScriptURL where Trusted Types are on; `new Worker` takes either.
  return p === null ? admit(u) : (p.createScriptURL(u) as string);
}

export function spawnRender(): Worker {
  return new Worker(scriptUrl(RENDER_URL), { type: 'module', name: 'dash-render' });
}

export function spawnPool(): Worker {
  return new Worker(scriptUrl(POOL_URL), { type: 'module', name: 'dash-pool' });
}
