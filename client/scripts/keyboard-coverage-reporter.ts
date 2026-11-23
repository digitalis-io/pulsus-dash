import type { FullConfig, FullResult, Reporter, Suite } from '@playwright/test/reporter';

// Stub (tests first, #130).
export function runFilter(
  _config: FullConfig,
  _env: NodeJS.ProcessEnv,
  _argv: readonly string[],
): string | undefined {
  return 'stub';
}

export default class KeyboardCoverageReporter implements Reporter {
  onBegin(_config: FullConfig, _suite: Suite): void {}

  onEnd(_result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    return Promise.resolve({ status: 'failed' });
  }

  printsToStdio(): boolean {
    return false;
  }
}
