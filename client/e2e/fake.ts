/**
 * The e2e PulsusDB fake's control routes (plan #63 §3.6, A.2): `tools/e2e/fake.sh 4190` serves the
 * transcripts of `e2e/transcripts/` with `--control`, which lists every request from arrival.
 */
import { expect, type APIRequestContext } from '@playwright/test';

export const FAKE = 'http://localhost:4190';

export type FakeState = 'inflight' | 'completed' | 'cancelled';

export interface FakeRequest {
  transcript: string;
  method: string;
  path: string;
  query: string;
  start: string;
  end: string;
  step: string;
  time: string;
  state: FakeState;
  receivedAtMs: number;
}

/** GET /__fake/requests (expects 200); the records whose every given field is === the filter's. */
export async function fakeRequests(
  request: APIRequestContext,
  f: Partial<FakeRequest>,
): Promise<FakeRequest[]> {
  const resp = await request.get(`${FAKE}/__fake/requests`);
  expect(resp.status()).toBe(200);
  const all = (await resp.json()) as FakeRequest[];
  const want = Object.entries(f) as [keyof FakeRequest, FakeRequest[keyof FakeRequest]][];
  return all.filter((r) => want.every(([k, v]) => r[k] === v));
}

/** POST /__fake/reset (expects 204). Single-worker debugging only (plan #63 §4.5). */
export async function resetFake(request: APIRequestContext): Promise<void> {
  const resp = await request.post(`${FAKE}/__fake/reset`);
  expect(resp.status()).toBe(204);
}

/** Seconds as the BFF sends `start`/`end`: `String(ms / 1000)` (1767225600000 → "1767225600"). */
export function sec(ms: number): string {
  return String(ms / 1000);
}
