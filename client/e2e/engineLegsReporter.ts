/**
 * Prints, at the head of an engine e2e run, whether the WebGPU leg is report-only
 * (`engine-legs.json`, plan #68 C1 §5.1), with its reason.
 */
import type { Reporter } from '@playwright/test/reporter';
import { LEGS, webgpuReportOnly } from './engine.ts';

export default class EngineLegsReporter implements Reporter {
  onBegin(): void {
    if (webgpuReportOnly()) console.log(`WebGPU leg report-only: ${LEGS.reason ?? 'no reason'}`);
  }

  printsToStdio(): boolean {
    return false;
  }
}
