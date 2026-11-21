/** INP per document from Event Timing entries (plan #61 Part C, Appendix C-A §A.6). Stub. */
export interface InpEntry {
  doc: number;
  interactionId: number;
  startTime: number;
  duration: number;
}
export interface InpStep {
  doc: number;
  label: string;
  count: number;
  t: number;
}
export interface InpDocResult {
  doc: number;
  inp: number;
  n: number;
  reported: number;
  slowest: { label: string; duration: number } | null;
}
export interface InpResult {
  documents: InpDocResult[];
  worst: number;
}

export function aggregateInp(entries: readonly InpEntry[], steps: readonly InpStep[]): InpResult {
  entries;
  steps;
  return { documents: [], worst: 0 };
}

export function gateFailures(r: InpResult, limitMs: number): InpDocResult[] {
  r;
  limitMs;
  return [];
}
