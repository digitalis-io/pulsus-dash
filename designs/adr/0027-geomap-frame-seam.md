# ADR-0027: The chart engine seam carries the geomap (`geomap` kind, geo events, `setFocusMark`, `cameraKey`) in one Web Mercator world that never repeats across ±180°; amends 0014 §3

| | |
|---|---|
| **Status** | Accepted (2026-11-25, on merge of the #184 step 1b design, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §3, the `ChartFrame` seam, after [ADR-0019](0019-chart-frame-drawn-event-and-frame-id.md), [ADR-0020](0020-chart-camera-commit-and-value-range.md), [ADR-0022](0022-chart-thresholds-and-stat-sparkline.md), [ADR-0023](0023-chart-event-markers.md) and [ADR-0025](0025-chart-frame-selection.md): one vis kind, one data member, one hover item, three events, two methods and one summary member. The rest of ADR-0014 is unchanged |
| **Source** | Issue #184 step 1b (the geomap frame: markers, camera, selection, Inspector, mark list, table and states) |
| **See** | [T24](../technical/T24-geo-schematic-and-widget-panels.md) §4.1 (T24-088 to T24-095), §4.11, §5.14 to §5.16; [T25](../technical/T25-inspector-and-pivots.md) §4.9; VIZ-044, VIZ-046, INT-002 to INT-004, INT-034 |

## Context

The geomap (VIZ-044, VIZ-046) draws series placed by their labels ([T24](../technical/T24-geo-schematic-and-widget-panels.md)
step 1a, `LocationResult`) over the bundled basemap. Its camera is not a time and value camera:
there is one zoom for both axes, the world is a Web Mercator square, and a commit moves a view
(`lat`, `lon`, `zoom`), not the time window. Its marks are markers and clusters, which the
engine places, clusters and hits, because only the engine knows the drawn geometry (as for bars,
ADR-0025). The keyboard mark list and the surface keys need to drive the camera about a chosen
mark. The seam (ADR-0014 §3) has none of this.

Step 1a's basemap is already split at ±180° (T24-086), and the decisions step 1b starts from ask
for a full ADR for that seam: either the map repeats horizontally, so a pan can cross the
antimeridian, or there is one world with edges.

## Decision

1. **One world.** The map is one Web Mercator world, never repeated. A row's longitude is brought
   into [−180, 180) by `((lon + 180) mod 360 + 360) mod 360 − 180`; u = (lon + 180)/360 and v = ½ −
   ln((1 + sin φ)/(1 − sin φ))/(4π); the inverse is lon = 360u − 180 and lat = atan(sinh(π(1 −
   2v))). At zoom z the world is 256·2^z CSS px. The camera is contained per axis inside the world,
   or centred and letterboxed when the world is smaller than the plot; it never crosses ±180°, and
   `GeoBounds` never wrap (`west < east`). Marks near the antimeridian are at the world's edges.
2. **The kind and its data.** `VisKind` adds `'geomap'`, `VisSpec` adds `GeoMapSpec` and
   `FrameData` adds `{ kind: 'geo'; geo: GeoFrame }` (T24 §5.15). `setTimeWindow` and `setEvents`
   are no-ops on a geomap frame.
3. **Hover and select.** `HoverItem` adds `{ kind: 'geo'; id; keys }`: `id` is a row key or
   `'cluster:' + seed`, and `keys` are the mark's row keys, sorted. A geomap `HoverEvent` has `tMs`
   null and `rows` `[]`; its `item` is the mark. `select` is ADR-0025's event with that item.
4. **Three events.** `FrameEvents` adds `geoCommit` (one per camera gesture that moved the view,
   with the gesture's kind), `geoBrush` (Alt+drag, the covered keys) and `geoMarks` (the marks in
   keyboard order with their in-view flags, on the first draw, after each commit, on new data and
   on a cluster level change).
5. **Two methods.** `setFocusMark(id | null)` draws the focus ring on a mark and makes it the zoom
   anchor of the keys. `cameraKey(k)` runs one camera key (`in`, `out`, `fit`, `panLeft`,
   `panRight`, `panUp`, `panDown`) about the focus mark if it is in view, else the centre; the plot
   surface and the hidden mark list both call it, so the list never needs the surface focused.
   Both are no-ops on other kinds.
6. **Summary.** `FrameSummary` adds `geo` (`{ view, bounds, level, marks, clusters }`, null for other
   kinds).
7. **Every engine behind the seam implements (1)–(6).** The WASM engine (#68) maps them before it
   replaces `engine/index.ts`.

The seam additions, verbatim (every field `readonly`):

```ts
export type VisKind = /* existing */ | 'geomap';
export interface GeoView { lat: number; lon: number; zoom: number } // |lat| ≤ 85.0511, lon ∈ [−180, 180), zoom ∈ [0, 14]
export interface GeoBounds { west: number; south: number; east: number; north: number } // −180 ≤ west < east ≤ 180
export interface GeoMapSpec { kind: 'geomap'; title: string; unit: Unit; view: GeoView | null /* null = fit */; motion: 'ease' | 'cut';
  size: { by: 'value' | 'fixed'; min: number; max: number }; colour: 'group' | 'state';
  symbol: 'circle' | 'square' | 'triangle' | 'diamond'; labels: 'auto' | 'none'; cluster: boolean; wheelZoom: boolean; thresholds?: ThresholdLine[] }
// VisSpec |= GeoMapSpec; FrameData |= { kind: 'geo'; geo: GeoFrame }; geomap HoverEvent: tMs null, rows [], item = the mark
// HoverItem |= { kind: 'geo'; id: string /* row key | 'cluster:' + seed */; keys: string[] /* sorted */ }
export interface GeoCommitEvent { view: GeoView; bounds: GeoBounds; gesture: 'wheel' | 'pan' | 'box' | 'keys' | 'fit' | 'dblclick' }
export interface GeoBrushEvent { keys: string[] }
export interface GeoMarksEvent { level: number; marks: { id: string; kind: 'marker' | 'cluster'; keys: string[]; inView: boolean }[] } // keyboard order
// FrameEvents += geoCommit, geoBrush, geoMarks (first draw, commits, data or level changes)
// ChartFrame += setFocusMark(id: string | null): void // focus ring, zoom anchor; no-op elsewhere
// ChartFrame += cameraKey(k: 'in' | 'out' | 'fit' | `pan${'Left' | 'Right' | 'Up' | 'Down'}`): void // anchor: the focus mark
// FrameSummary += geo: { view: GeoView; bounds: GeoBounds; level: number; marks: number; clusters: number } | null
// setTimeWindow, setEvents: no-op on a geomap frame
```

## Consequences

- `ChartFrame` gains two methods and `FrameEvents` three events; `HoverItem`, `VisKind`,
  `VisSpec`, `FrameData` and `FrameSummary` each gain a member. Other kinds draw and behave exactly
  as before, so their parity fixtures and gallery goldens are unchanged.
- A map cannot be panned across the antimeridian. A Pacific estate (for example Fiji's two
  halves) shows at both edges of one world; wrapping is a later decision (T24 §2 non-goals).
- The camera owns the view; the host owns the persisted `options.view` and hands a new value to
  the engine only when it changes (T24-088, T24-091).
- There is no dependency or bundle change beyond the geomap modules (T24 §7).

## Alternatives considered

| Alternative | Why not |
|---|---|
| A horizontally repeated world (wrap across ±180°) | Every mark, cluster, pick and bound needs copies; bounds would wrap, which the step 2 bounds filter cannot express as one box; the basemap is split at ±180° already (T24-086) |
| Neutral marker colour with identity only in the tooltip | Series identity must have a visible second channel (VIZ-067); groups carry colour and pattern (T24-090) |
| State shown by rings alone | A ring is not distinguishable in greyscale at small radii; state uses a fill or outline plus a glyph (T24-090) |
| Spreading coincident marks apart | It moves marks off their true place; clusters and the pick order keep every coincident mark reachable (T24-091) |
| Picking and clustering in the component | The component does not know the drawn geometry (radii, clusters, crossfades); the engine does (as ADR-0025) |
| Driving the camera keys only from the focused surface | The mark list owns focus while it is used; it would have to move focus to the surface for every key (`cameraKey`) |
| A note on ADR-0014 §3 | It would change an Accepted ADR, which can change only through a later ADR |
