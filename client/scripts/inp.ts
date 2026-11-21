/**
 * INP per document from Event Timing entries (plan #61 Part C, Appendix C-A §A.6; PRF-033). INP is
 * a per-document metric, so each document the script loads is aggregated and enforced on its own,
 * with its own interaction count for the one-outlier-per-50 rule; documents are never pooled.
 */
export interface InpEntry {
  doc: number;
  interactionId: number;
  startTime: number;
  duration: number;
}
export interface InpStep {
  doc: number;
  label: string;
  /** Clicks and key presses the step performs. */
  count: number;
  t: number;
}
export interface InpDocResult {
  doc: number;
  inp: number;
  /** Interactions performed (Σ of the document's step counts). */
  n: number;
  /** Interactions the browser reported (only those of 16 ms or more are). */
  reported: number;
  slowest: { label: string; duration: number } | null;
}
export interface InpResult {
  /** Sorted by `doc`. */
  documents: InpDocResult[];
  /** The largest document INP. */
  worst: number;
}

/** The label of the last step at or before `startTime`, else `unlabelled`. */
function labelOf(steps: readonly InpStep[], startTime: number): string {
  let label = 'unlabelled';
  for (const s of steps) if (s.t <= startTime) label = s.label;
  return label;
}

function aggregateDoc(doc: number, entries: readonly InpEntry[], steps: InpStep[]): InpDocResult {
  steps.sort((a, b) => a.t - b.t);
  const n = steps.reduce((sum, s) => sum + s.count, 0);
  // Interaction ids restart in each document; the entries of one interaction count once.
  const interactions = new Map<number, { startTime: number; duration: number }>();
  for (const e of entries) {
    const i = interactions.get(e.interactionId);
    interactions.set(e.interactionId, {
      startTime: Math.min(i?.startTime ?? Infinity, e.startTime),
      duration: Math.max(i?.duration ?? 0, e.duration),
    });
  }
  const reported = interactions.size;
  if (reported > n) throw new Error('more interactions reported than performed');
  const durations = [...interactions.values()].map((i) => i.duration);
  // Unreported interactions were under 16 ms: zeros, so the outlier rule counts them.
  const padded = [...durations, ...Array<number>(n - reported).fill(0)].sort((a, b) => b - a);
  const inp = padded[Math.floor(n / 50)] ?? 0;
  let slowest: InpDocResult['slowest'] = null;
  for (const i of interactions.values()) {
    if (slowest === null || i.duration > slowest.duration) {
      slowest = { label: labelOf(steps, i.startTime), duration: i.duration };
    }
  }
  return { doc, inp, n, reported, slowest };
}

export function aggregateInp(entries: readonly InpEntry[], steps: readonly InpStep[]): InpResult {
  const docs = [...new Set(steps.map((s) => s.doc))].sort((a, b) => a - b);
  if (entries.some((e) => !docs.includes(e.doc))) {
    throw new Error('entries for an unscripted document');
  }
  const documents = docs.map((doc) =>
    aggregateDoc(
      doc,
      entries.filter((e) => e.doc === doc),
      steps.filter((s) => s.doc === doc),
    ),
  );
  return { documents, worst: Math.max(0, ...documents.map((d) => d.inp)) };
}

/** The documents whose INP exceeds `limitMs` (the enforce mode asserts this is empty). */
export function gateFailures(r: InpResult, limitMs: number): InpDocResult[] {
  return r.documents.filter((d) => d.inp > limitMs);
}
