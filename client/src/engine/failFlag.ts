/**
 * The page's engine failure flag (plan #68 C1 §4.3, T03-025): after a fatal engine failure, this
 * page and later pages of the session start on Canvas 2D. The flag lives in module memory for the
 * page and in `sessionStorage` for the session; storage that throws (blocked, or in a sandbox) is
 * ignored. Limitation: without storage a reload tries the engine again.
 */
const KEY = 'pulsus-dash.engine-failed';

let failed = false;

export function sessionFailed(): boolean {
  if (failed) return true;
  try {
    return sessionStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function markSessionFailed(): void {
  failed = true;
  try {
    sessionStorage.setItem(KEY, '1');
  } catch {
    // The memory flag still holds for this page.
  }
}
