# ADR-0020: The chart engine seam reports camera commits and carries a value-axis range

| | |
|---|---|
| **Status** | Accepted (2026-11-21, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3, the `ChartFrame` seam, after [ADR-0019](0019-chart-frame-drawn-event-and-frame-id.md): three additive members. The rest of ADR-0014 is unchanged |
| **Source** | Issue #93 (plan review r1), owner decisions of 2026-11-21 (time commits to the Context, value zoom local to the chart) |
| **See** | [T02](../technical/T02-vis-engine.md) §0, §4.3, §4.6, T02-021; [T03](../technical/T03-browser-runtime.md) §4.4; [03](../product/03-interaction-model.md) §4.1 |

## Context

ADR-0014 §3 says the engine reports commits, but the seam's `FrameEvents` lists only `hover`,
`brush`, `select`, `a11y` (and `drawn`, ADR-0019). Interim 2D zoom and pan (#93) preview the camera
in the frame and must hand the application one committed move per gesture (T03 §4.4, T03-009). The
owner ruled that a value-axis range is chart view state, not Context, so the application must be
able to hand it back to the engine; T02 §4.3 puts axis ranges in the viewport spec. Assistive text
must say when the value axis is fixed.

## Decision

1. **`commit` event.** `FrameEvents` adds `commit: CommitEvent`, emitted once when a camera gesture
   ends and changed the view. It carries only the axes the gesture moved: `window` is null when it
   did not move time, `value` is null when it did not move values, and `'auto'` clears the pin. It
   is never emitted after `dispose`.
2. **Value range in the spec.** `VisSpec` line and bars add `readonly valueRange?: ValueRange`;
   absent means auto.
3. **Drawn value axis in the summary.** `FrameSummary` adds `valueAxis` (`{ min, max, manual } |
   null`).
4. **Every engine behind the seam implements all three.** The later `WasmEngine` emits `commit`
   from the worker's gesture end.

The seam additions, verbatim:

```ts
/** A value-axis range in data units; `min < max`, both finite. */
export interface ValueRange {
  readonly min: number;
  readonly max: number;
}

export type VisSpec =
  | { readonly kind: 'line'; readonly title: string; readonly unit: Unit;
      /** The user's value-axis pin (#93); absent = auto. */
      readonly valueRange?: ValueRange }
  | { readonly kind: 'bars'; /* existing fields unchanged */ readonly valueRange?: ValueRange }
  | { readonly kind: 'heatmap'; /* unchanged */ }
  | { readonly kind: 'stat'; /* unchanged */ };

/** A committed camera move (T03 §4.4): the gesture ended and changed the view. */
export interface CommitEvent {
  /** The new absolute window, whole ms, `fromMs < toMs`; null when the gesture did not move time. */
  readonly window: TimeWindow | null;
  /** A new manual value range; `'auto'` clears the pin; null when the gesture did not move values. */
  readonly value: ValueRange | 'auto' | null;
  readonly gesture: 'wheel' | 'pan' | 'axis' | 'fit';
}

export interface FrameSummary {
  // existing fields unchanged
  /** The drawn value axis (line, bars); null for heatmap and stat. */
  readonly valueAxis: { readonly min: number; readonly max: number; readonly manual: boolean } | null;
}

export interface FrameEvents {
  hover: HoverEvent | null; brush: BrushEvent; select: SelectEvent; a11y: FrameSummary; // unchanged
  drawn: DrawnEvent; // #90, unchanged
  commit: CommitEvent; // new
}
```

## Consequences

- The application, not the engine, owns the Context window and the value pin. A commit becomes one
  `setRange` push (one history entry, T03-016) and a spec change.
- There is no new method on `ChartFrame`. The event list becomes `hover`, `brush`, `select`,
  `a11y`, `drawn`, `commit`.
- There is no dependency or bundle change.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A note on ADR-0014 §3 | It would change an Accepted ADR, which can change only through a later ADR |
| A `setValueRange` method on `ChartFrame` | T02 §4.3 puts axis ranges in the viewport spec; an optional spec field changes no method |
