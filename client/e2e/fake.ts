/**
 * The e2e PulsusDB fake's control routes (plan #63 §3.6, A.2): `tools/e2e/fake.sh 4190` serves the
 * transcripts of `e2e/transcripts/` with `--control`, which lists every request from arrival.
 */
import { expect, type APIRequestContext, type TestInfo } from '@playwright/test';

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

/**
 * The `query_range` records whose grid covers `[fromMs, toMs]` (and match `f`): a store-backed
 * panel asks for bucket-aligned runs (#304), so a window's request starts at or before it and ends
 * at or after it; flank and ladder requests (outside the window) do not cover it.
 */
export async function covering(
  request: APIRequestContext,
  fromMs: number,
  toMs: number,
  f: Partial<FakeRequest> = {},
): Promise<FakeRequest[]> {
  const all = await fakeRequests(request, { path: '/api/v1/query_range', ...f });
  return all.filter((r) => Number(r.start) * 1000 <= fromMs && Number(r.end) * 1000 >= toMs);
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

/**
 * A shift for a test's windows, so each run of it (a repeat or a retry) reads only its own records:
 * the fake keeps every request since it started. Whole minutes keep the windows on every step.
 */
export function runShift(info: TestInfo): number {
  return (info.repeatEachIndex * 4 + info.retry) * 60_000;
}
