# 03 — Interaction model

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.4-rc · 2026-11-25 |
| **Requirement area** | `INT` |
| **Source draft** | plans/03-interaction-model.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [02](02-information-architecture.md), [04](04-surfaces.md), [05](05-visualisation-catalogue.md), [06](06-ai-copilot.md), [07](07-alerting.md), [08](08-visual-language.md), [09](09-performance-contract.md), [15](15-estate-navigation.md) |
| **Mockups** | [01-landscape-map](../mockups/01-landscape-map.svg), [22-topology-3d](../mockups/22-topology-3d.svg), [05-service-lens](../mockups/05-service-lens.svg), [06-metrics-workbench](../mockups/06-metrics-workbench.svg), [15-command-palette](../mockups/15-command-palette.svg), [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg), [21-floors-3d](../mockups/21-floors-3d.svg), [23-semantic-zoom-flight](../mockups/23-semantic-zoom-flight.svg), [25-fleet-line-stack-3d](../mockups/25-fleet-line-stack-3d.svg) |

## 1. Purpose & scope

Navigating telemetry should feel like flying a camera in a well-made game or a CAD/3D tool:
immediate, physical, predictable, not like submitting forms. This document specifies the camera,
the mouse, keyboard, gamepad and touch bindings and the rules that keep them conflict-free,
semantic zoom, time as a dimension, selection/inspection/pivot, the command palette and undo.

The estate-navigation behaviour behind `V`, `Alt+1`–`Alt+7` and `Home` is specified in
[15](15-estate-navigation.md); the analysis behaviour behind `B`, `C` and `X` in
[05](05-visualisation-catalogue.md) and [04](04-surfaces.md); the AI behaviour behind `.` and `D`
in [06](06-ai-copilot.md). This document owns the bindings themselves.

## 2. Definitions

| Term | Meaning |
|---|---|
| **Camera** | The view transform of a scene or viewport: orthographic per-axis for 2D, perspective for 3D |
| **Committed move** | A camera move that ends (inertia settled, transition complete, or programmatic move done); committed moves enter camera history |
| **Semantic level** | One rung of the zoom ladder in §5 (Estate, Cluster, Service, Instance, Request, Code) |
| **Dive** | Move one semantic level down into the selected entity |
| **Tap / hold** | A key released within 250 ms is a tap; a key held for ≥ 250 ms is a hold |
| **Input context** | The set of bindings active for the current focus (§3.3) |
| **Inspector** | The right-hand floating, collapsible detail panel for the current selection |
| **Pivot chip** | A context-aware jump from the Inspector to another signal or entity that keeps Context |
| **Time cursor** | The single global vertical cursor shown on every time-based viewport |

## 3. The camera

Every scene has a camera. 2D scenes use an orthographic camera (pan + zoom per axis). 3D scenes use
a perspective camera with three modes. The estate is 3D-first ([15](15-estate-navigation.md)
EST-055): the Landscape, City, Infra and large-graph Topology views open as 3D scenes in Orbit mode.

| Mode | Used by | Behaviour |
|---|---|---|
| **Orbit** (default 3D) | Atlas estate views (Map, City, Infra, 3D Topology, floors), 3D signal views, trace skyline | Rotate around a focus point over the ground plane; zoom moves toward the point under the cursor; double-click dives |
| **Fly** (toggle with `` ` ``, or hold right mouse + `W`/`A`/`S`/`D`) | Large Atlas, NOC exploration | Free first-person flight, game-editor style |
| **Map** (2.5D, tilt-locked) | Any 3D estate view, on request | Top-down, tilt-locked, like a strategy game: pan with drag, zoom with wheel, `Q`/`E` rotate. Selected from the orbit gizmo's top face or the palette ("camera: map"); never the default |

Mockups: [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg),
[23-semantic-zoom-flight](../mockups/23-semantic-zoom-flight.svg),
[22-topology-3d](../mockups/22-topology-3d.svg).

#### INT-001 — Camera per scene and camera modes
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Every 2D scene MUST have an orthographic camera with independent pan and zoom per axis. Every 3D
scene MUST have a perspective camera offering the Orbit, Fly and Map modes in the table above, with
Orbit the default in every 3D scene, including every estate view at every estate size
([15](15-estate-navigation.md) EST-055). Map mode MUST be entered only on request.

*Acceptance:* Each 3D scene, including the Landscape of a 10k-node estate, opens in Orbit mode; `` ` `` toggles Fly and back; in Map mode
the camera cannot tilt and `Q`/`E` rotate it; in a 2D chart, X and Y zoom independently.

*Note (#184, [T24](../technical/T24-geo-schematic-and-widget-panels.md#t24-091--camera-and-picking)):*
a 2D map (the geomap) is a 2D scene whose orthographic camera has one zoom for both axes, because a
Web Mercator map has no independent axes; it pans and zooms within one world that never repeats
([ADR-0027](../adr/0027-geomap-frame-seam.md)). The acceptance's independent zoom applies
to 2D charts.

#### INT-002 — Cursor-anchored zoom
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

Zoom MUST keep the data point under the pointer under the pointer, always, in 2D and 3D.

*Acceptance:* For 100 random wheel-zoom steps on a line chart and on the Atlas, the data coordinate
under the pointer moves by < 1 px between frames.

#### INT-003 — Inertia
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

A flick-pan MUST continue and decay as a critically damped spring settling in about 300 ms, and MUST
be interruptible instantly by any new input.

*Acceptance:* After a flick, motion settles within 300 ms ± 50 ms with no overshoot; a pointer-down
during the decay stops motion on the next frame.

#### INT-004 — Smooth programmatic transitions
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every programmatic camera move (focus, back, dive, AI "show me") MUST be an eased flight of
≤ 250 ms, and MUST be an instant cut when `prefers-reduced-motion` is set (PRF-007 in
[09](09-performance-contract.md)).

*Acceptance:* As PRF-007.

#### INT-005 — No motion sickness
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

In Orbit mode the horizon MUST be kept level; roll MUST never be applied in any mode; the field of
view MUST be fixed at 50°.

*Acceptance:* After any sequence of orbit, fly and programmatic moves, camera roll is 0° and FOV is
50°; in Orbit mode the horizon is level.

#### INT-006 — Camera history
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

Every committed move MUST be pushed onto camera history; `Alt+←` / `Alt+→` and the mouse back/forward
buttons MUST step through it, as does browser back/forward (IA-025 in
[02](02-information-architecture.md)).

*Acceptance:* After three committed moves, `Alt+←` three times, or mouse-back three times, returns
through each pose in reverse; `Alt+→` replays forward.

## 4. Input mapping

### 4.1 Mouse and trackpad (primary)

| Input | 2D chart | 3D scene |
|---|---|---|
| Wheel / pinch | Zoom X (time) around cursor | Dolly toward cursor point (3D signal views: zoom the time axis) |
| `Shift` + wheel | Zoom Y | 3D signal views: zoom the value axis |
| `Alt` + wheel | — | 3D signal views: zoom lane depth ([05](05-visualisation-catalogue.md) VIZ-085) |
| `Ctrl`/`⌘` + wheel | Zoom both axes | Change height (FOV-free) in Map mode; dolly along depth in 3D signal views |
| Left drag (empty space) | Pan (with inertia) | Orbit (Orbit mode) / pan (Map mode) |
| Right drag | Box-zoom | Pan |
| Right button held + `W`/`A`/`S`/`D` | — | Fly while held (enters Fly context) |
| Middle drag | Pan | Pan |
| `Alt` + left drag | **Brush** time range → becomes Context time (undoable) | Lasso-select entities |
| Hover | Crosshair + tooltip, synchronised across all viewports in the scene | Highlight entity + its edges; label pops |
| Click | Select point/series → Inspector | Select entity → Inspector |
| `Shift`+click on a pivot chip | Replace the current view with the pivot target | Same |
| `⌘`/`Ctrl`+click on a pivot chip | Open the pivot target in a new browser tab | Same |
| Double-click | Zoom the time window out ×2 around its centre | **Dive**: fly into entity, one level down the ladder (L0 → L5) and finally its Lens; on empty space in a 3D signal view, reset the camera |
| Two-finger swipe (trackpad) | Pan | Pan |
| Mouse back / forward button | Camera history back / forward | Same |
| Drag on an axis | Pan **that axis only**. On a comparison time axis, slides B against A ([05](05-visualisation-catalogue.md) §1.1) | — |
| Wheel on an axis | Zoom that axis only | — |
| Double-click on an axis | Fit that axis (clears its manual-range pin) | — |

[mockup](../mockups/06-metrics-workbench.svg)

> **Note (2026-11-21, #93, owner decisions):** In 2D charts, time zoom and pan change the
> Context time window (on a board, the board's shared range, so every panel follows); they are
> committed at the end of the gesture (wheel idle 300 ms, pointer release), one history entry
> each. Value-axis zoom and pan stay local to the chart until it is reset (a Reset Y axis
> control, or double-click on the value axis) and are not in the URL. The wheel zooms a chart
> only while the pointer is over its plot; elsewhere the page scrolls, and a scroll already in
> progress keeps scrolling over a plot. A trackpad pinch arrives as `Ctrl`+wheel with
> fractional deltas and zooms time only; `Ctrl`/`⌘`+wheel with whole-number steps zooms both
> axes (a heuristic; a mouse with fractional deltas or a pinch with whole steps maps the other
> way, which is accepted). Right drag (and `Alt`+left drag) box-zooms the time span, replacing
> the earlier left-drag brush; on the plot, neither a right drag nor a right click opens the
> browser menu, and outside the plot right click is unchanged.

> **Note (#184, 2D maps):** On a 2D map ([T24-091](../technical/T24-geo-schematic-and-widget-panels.md#t24-091--camera-and-picking))
> the wheel zooms both axes about the pointer (over the map only; a panel can turn wheel zoom off,
> so the page scrolls), a left drag pans, a right drag box-fits, `Alt`+left drag selects the marks
> it covers (not a time range), and a double-click zooms ×2, or fits a cluster's members when it is
> on a cluster. A map move commits a view, never the time window.

#### INT-007 — Mouse and trackpad bindings
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every mouse and trackpad input in the §4.1 table MUST perform the listed action in 2D charts from
M-UI1 and in 3D scenes from M-UI3.

*Acceptance:* An automated input test per table row asserts the resulting camera, selection or
Context change in a 2D chart and in a 3D scene.

#### INT-008 — Per-axis pan, zoom and fit
**MUST** · M-UI1 · Platform, Engineer, SRE

Dragging on an axis MUST pan only that axis; wheel on an axis MUST zoom only that axis around the
cursor; double-click on an axis MUST fit that axis to the data and clear its manual-range pin. On a
comparison time axis (under `C` or `Shift+C`), dragging MUST slide window B against window A
([05](05-visualisation-catalogue.md) §1.1).

*Acceptance:* On a line chart, dragging the Y axis changes only the Y range; wheel on the X axis
changes only the X range; double-click on the Y axis restores auto-range and removes the pin icon;
with the baseline ghost on, dragging the top time axis shifts the ghost by the dragged time and
updates its label.

### 4.2 Keyboard (expert speed)

Bindings are grouped by the input context in which they apply (§4.3). **Ctx** values: **G** Global,
**S** Space (any Space scene with the canvas focused), **Est** estate view or Alerts-room view,
**3D** 3D scene (Orbit or Map), **Fly** Fly mode, **Board** Board (view mode), **Room** rooms. `⌘` means `Ctrl` on
Windows and Linux. † marks an inner-context override (§4.3).

| Key | Action | Ctx | Milestone |
|---|---|---|---|
| `⌘K` | Command palette: go to any entity, board, alert, action, query (§8) | G | M-UI1 |
| `?` | Overlay of all shortcuts for the current scene and context | G | M-UI1 |
| `g` then `a`/`b`/`i`/`s`/`l`/`t`/`m`/`p` | Go to Alerts / Boards / Investigations / Space (Atlas) / Logs / Traces / Metrics / Profiles | G | M-UI1 |
| `⌘Z` / `⌘⇧Z` | Undo / redo (§9) | G | M-UI1 |
| `Alt+←` / `Alt+→` | Camera history back / forward | G | M-UI1 |
| `F6` / `Shift+F6` | Move keyboard focus to the next / previous region (sidebar, page header, page content, open panels; the Time Ribbon in Space scenes) | G | M-UI1 |
| `Esc` | Exit Fly → clear selection → close Inspector → **zoom out one semantic level** (repeated `Esc` returns to the Atlas) | S | M-UI1 |
| `Enter` | Dive into selected entity / open selected item | S | M-UI2 |
| `Tab` / `Shift+Tab` | Cycle selection through entities/series in view by care score, worst first ([01a](01a-audiences-and-perspectives.md) AUD-010) | S | M-UI2 |
| `/` | Focus the find/filter bar of the current scene (in workbenches: the query bar) | S | M-UI1 |
| `n` / `N` | Next / previous find match, flying the camera to it | S | M-UI3 |
| `F` / `Shift+F` | Frame selected (fit camera) / frame all | S | M-UI1 |
| `←` `↑` `→` `↓` (+`Shift` fast) | Pan | S | M-UI1 |
| `Space` (hold) + move mouse | **Time scrub**: horizontal motion scrubs the global time cursor; release to commit | S | M-UI1 |
| `[` / `]` | Step time window back / forward by one window width | S | M-UI1 |
| `-` / `=` | Zoom time window out / in (×2) | S | M-UI1 |
| `L` | Toggle LIVE (follow now) | S | M-UI1 |
| `Shift+C` | Toggle comparison ghost (baseline overlay) on the focused viewport | S | M-UI1 |
| `C` | **A/B Everything**: puts the whole scene into A-vs-B diff mode | S | M-UI6 |
| `B` | **Universal Compare** on the current selection/brush (different · unchanged · coverage) | S | M-UI3 |
| `X` | Show only the anomalous subgraph / anomalous series (+1 hop context) | S | M-UI3 |
| `T` | Toggle between a 3D view and its 2D equivalent (estate views default to 3D; [15](15-estate-navigation.md) EST-055) | S | M-UI3 |
| `Shift+T` | Toggle the table view of the focused viewport | S | M-UI1 |
| `\` | Split screen: two linked views side by side | S | M-UI2 |
| `1`–`9` / `Shift+1`–`Shift+9` | Jump to waypoint n / save current position as waypoint n | S | M-UI3 |
| `P` | Pin current viewport/selection to the active Investigation | S | M-UI4 |
| `.` (tap) | Open the AI copilot with the current selection as context ("explain this") | S | M-UI4 |
| `.` (hold) | Point-and-ask: point at anything while held to scope the question | S | M-UI4 |
| `D` (hold) + draw | **Draw-to-ask**: draw/circle/lasso on any view to scope the AI | S | M-UI4 |
| `Shift+A` | Acknowledge the focused alert / incident | S | M-UI4 |
| `Home` | Back to the Landscape (whole estate) | S | M-UI3 |
| `V` (tap) | **Floors**: flip between the application and infrastructure floor for the focused entity | S | M-UI3 |
| `V` (hold) | Show both floors with runs-on threads | S | M-UI3 |
| `Alt+1`–`Alt+6` | Switch view: Map · Topology · City · Infra · Segments · Explorer (in the Alerts room: List) | Est | M-UI3 |
| `Alt+7` | Switch to Timeline view | Est (Alerts room only) | M-UI4 |
| `↑` / `↓` | Move row selection in the Explorer / List † | Est | M-UI3 |
| `Q` / `E` | Rotate | 3D | M-UI3 |
| `` ` `` | Toggle Fly mode | 3D | M-UI3 |
| `W` `A` `S` `D` (+`Shift` fast) | Fly forward / left / back / right † | Fly | M-UI3 |
| `Shift+E` | Enter Board edit mode ([04](04-surfaces.md)) | Board | M-UI5 |

### 4.3 Input contexts and conflict rules

| Context | Active when |
|---|---|
| **Text input** | A text field, query editor, find bar or the palette input has focus |
| **Fly** | Fly mode is on (toggled with `` ` ``, or while the right mouse button is held with `W`/`A`/`S`/`D`) |
| **3D** | A 3D scene or 3D viewport has focus, in Orbit or Map mode |
| **Est** | An estate view ([15](15-estate-navigation.md) §5) or Alerts-room view ([07](07-alerting.md)) is shown |
| **Board** | A Board is open in view mode |
| **S** | Any Space scene with the canvas focused |
| **Room** | A DOM room has focus (standard DOM keyboard behaviour: `Tab`, `Space`, `Enter`, arrows) |
| **G** | Always, except in Text input |

Precedence, innermost first: Text input → Fly → 3D → Est / Board → S / Room → G.

#### INT-009 — Keyboard bindings
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every key in the §4.2 table MUST perform the listed action in its context from its milestone.

*Acceptance:* An automated input test per table row asserts the listed effect in the listed context
at the listed milestone build.

#### INT-010 — No key bound to two actions in one context
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

No key, including its modifiers and its tap/hold distinction, MAY be bound to two actions in the same
context. An inner context MAY rebind a key of an outer context only where the binding table marks
the override (†). `⌘K`, `?`, `Esc`, `⌘Z` and `⌘⇧Z` are reserved: only Text input MAY override them
(`Esc` leaves the field; `⌘Z` undoes typing). The same rules MUST be enforced on user remaps and
presets.

*Acceptance:* A CI check over the binding tables (default and every shipped preset) fails on any
duplicate key in one context, and on any unmarked override; attempting a conflicting remap in
preferences is refused with a message naming the existing action.

#### INT-011 — Tap and hold
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

For keys with both tap and hold actions (`.`, `V`) and hold-only actions (`Space`, `D`), a key
released within 250 ms MUST be treated as a tap and a key held ≥ 250 ms as a hold; a hold action
MUST end on release.

*Acceptance:* Pressing `V` for 100 ms flips floors; pressing it for 400 ms shows both floors and
releasing restores the previous floor.

#### INT-012 — Chords
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Admin

After `g`, the next key within 1 s MUST complete the chord; any other key or a 1 s timeout MUST
cancel it with no side effect. `g` MUST NOT be bound alone.

*Acceptance:* `g` then `a` within 1 s opens the Alerts room; `g`, a 1.2 s wait, then `a` does
nothing.

#### INT-013 — Remappable bindings and presets
**MUST** · M-UI5 · SRE, Platform, Engineer

All keyboard bindings MUST be user-remappable, stored in user preferences, with a Vim-ish preset and
a "Classic dashboard" preset shipped. Bindings for letters, digits and punctuation MUST match the physical
key position, so `Shift+1`–`Shift+9` and `?` work on non-US layouts, and the `?` overlay MUST show
the user's layout labels.

*Acceptance:* Remapping "Frame selected" from `F` to `Z` takes effect immediately and persists across
devices; selecting each preset applies its table; on a German layout, `Shift+1` saves waypoint 1.

#### INT-014 — Shortcut overlay
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

`?` MUST overlay every binding active in the current scene and context, reflecting the user's
remaps.

*Acceptance:* `?` in the Atlas lists the S, Est and 3D bindings and not Board-only bindings; after a remap,
the overlay shows the new key.

#### INT-015 — Keyboard focus is never trapped
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

Because `Tab` cycles selection inside the canvas, `F6` / `Shift+F6` MUST move keyboard focus between
regions in the order sidebar → page header → page content → open panels, plus the Time Ribbon in
Space scenes ([02](02-information-architecture.md) IA-016, IA-028), so a keyboard-only user can always
leave the canvas.

*Acceptance:* With focus in a chart canvas, `F6` moves focus to the next region in that order and
`Shift+F6` to the previous one; no region retains focus after `F6`.

#### INT-016 — Esc and Enter ladder
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

`Esc` MUST perform the first applicable step of: exit Fly → clear selection → close Inspector → zoom
out one semantic level, so repeated `Esc` returns to the Atlas. `Enter` MUST dive into the selected
entity or open the selected item ([01a](01a-audiences-and-perspectives.md) AUD-042).

*Acceptance:* From a pod Lens with a selection and the Inspector open, `Esc` clears the selection,
then closes the Inspector, then rises to the service Lens, then to the Atlas.

*Note (#164, [T25](../technical/T25-inspector-and-pivots.md#t25-007--one-esc-ladder)):* on boards and Explore one host owns the ladder
(T25-007); a kind's own steps go before (`pre`) and after (`post`) the host's clear selection and
close Inspector steps.

#### INT-017 — Time scrub
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

Holding `Space` and moving the mouse horizontally MUST scrub the global time cursor; releasing MUST
commit the new cursor position.

*Acceptance:* Holding `Space` and moving 200 px right moves the time cursor proportionally to the
time scale of the chart under the pointer (the Time Ribbon scale in Space scenes) in every time
viewport; release leaves it there; the scrub updates at the frame
rate of PRF-001.

### 4.4 Gamepad and 3D mouse (stretch, NOC walls)

| Input | Action |
|---|---|
| Left stick | Pan |
| Right stick | Orbit |
| Triggers | Zoom |
| D-pad | Cycle anomalies (care order) |
| A / B | Dive / back |
| SpaceMouse (WebHID) | 6-DoF camera control (roll suppressed, INT-005) |

#### INT-018 — Gamepad and 3D mouse
**MAY** · M-UI6 · NOC

Pulsus MAY support the Gamepad API and SpaceMouse (via WebHID) with the mapping above, once the
camera is abstracted.

*Acceptance:* With a standard gamepad connected, each mapping in the table performs its action on the
NOC wall.

### 4.5 Touch (tablet, read-mostly)

| Gesture | Action |
|---|---|
| Pinch | Zoom |
| One-finger drag | Pan |
| Two-finger rotate | Rotate (3D) |
| Long-press | Inspect |
| Double-tap | Dive |

#### INT-019 — Touch gestures
**SHOULD** · M-UI4 · SRE, Business, Support

Tablets and the mobile PWA SHOULD support the touch gestures above.

*Acceptance:* On a tablet, each gesture in the table performs its action in a Lens and in the Atlas.

## 5. Semantic zoom

Zoom is not just magnification: the visualisation changes as you cross levels of detail,
continuously and with crossfades, so you never lose your place.

```
Zoom level ▸   Estate          Cluster          Service           Instance          Request         Code
            ┌────────────┐  ┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  ┌─────────┐
Atlas  ───► │ regions as │─►│ services as│─►│ service Lens:│─►│ pod Lens:    │─►│ trace      │─►│ flame   │
            │ glowing    │  │ nodes, live│  │ RED, logs,   │  │ USE, logs,   │  │ waterfall, │  │ graph of│
            │ territories│  │ edges      │  │ span scatter │  │ spans, prof. │  │ span logs  │  │ the span│
            └────────────┘  └────────────┘  └──────────────┘  └──────────────┘  └────────────┘  └─────────┘
 data:       rollup health    service graph   PromQL + LogQL     same, instance   TraceQL fetch   profiles
             (1 num/entity)   + RED rollups   + TraceQL          filtered          by trace_id     merge by span
```

This ladder is the application path. The infrastructure ladder (region → zone → cluster → node pool
→ node → pod → container; DC → rack → host → process) and crossing between the two with `V` are in
[15](15-estate-navigation.md) §3. In 3D the infrastructure ladder is one continuous camera flight,
globe → region plateau → cluster district → node building → pod slab → container cell, each leg
≤ 250 ms with approach pre-fetch ([15](15-estate-navigation.md) EST-060), tracked by the altitude
ladder (INT-044).

[mockup](../mockups/05-service-lens.svg)

#### INT-020 — The semantic-zoom ladder
**MUST** · M-UI3 · SRE, Platform, Engineer

Zooming or diving MUST move through the levels Estate → Cluster → Service → Instance → Request →
Code with the visualisation and data source of each level as in the ladder above, crossfading between
levels.

*Acceptance:* Starting at the Estate level and diving repeatedly into `checkout`, a pod, a trace and a
span shows, in order, glowing territories, service nodes with live edges, the service Lens, the pod
Lens, the trace waterfall and the span's flame graph, each with a crossfade.

#### INT-021 — Continuity across levels
**MUST** · M-UI3 · SRE, Platform, Engineer

The clicked object MUST morph into the next level's frame (its node becomes the Lens header; its
health ring becomes the RED sparkline) so users keep spatial memory.

*Acceptance:* In a frame capture of a dive from the Atlas into `checkout`, the node's screen position
interpolates continuously into the Lens header position, with no frame where neither is visible.

#### INT-022 — Pre-fetch on approach
**MUST** · M-UI2 · SRE, Platform, Engineer

As the camera nears a level threshold, or dwells on an entity for > 300 ms, the next level's data
MUST be requested at low resolution so it is present on arrival (PRF-029 in
[09](09-performance-contract.md)).

*Acceptance:* As PRF-029.

#### INT-023 — Reversible zoom
**MUST** · M-UI2 · SRE, Platform, Engineer

`Esc` or zooming out MUST return to the exact previous camera.

*Acceptance:* After diving and pressing `Esc`, the camera pose equals the pre-dive pose to within
1 px and 0.1°.

#### INT-024 — Semantic zoom in 2D charts
**MUST** · M-UI2 · SRE, Platform, Engineer

In 2D charts, zoom MUST change representation: zooming a time series past the stored rollup
resolution MUST switch from rollups to raw samples; zooming a log-volume histogram far enough MUST
turn bars into individual log lines; zooming the span-duration scatter far enough MUST turn dots into
mini-waterfalls.

*Acceptance:* On seeded data, each of the three zooms crosses its threshold and the representation
changes, with the source badge ([09](09-performance-contract.md) PRF-025) updated for the time series.

### 5.1 Camera aids for 3D scenes

#### INT-042 — Orbit constraints
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

In Orbit mode the camera MUST orbit the focus point (the selected entity, else the point under the
cursor at drag start), MUST keep its pitch between 10° and 89° above the ground plane so that it
never passes below the ground, and MUST keep `Q`/`E` as continuous heading rotation around the focus.
Left drag MUST orbit and right or middle drag MUST pan along the ground plane (§4.1).

*Acceptance:* After any sequence of orbit drags, the camera pitch stays within 10°–89° and the
ground is never seen from below; holding `E` for 1 s rotates the heading about the focus with the
focus fixed on screen to within 1 px.

#### INT-043 — Orbit gizmo and compass
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Every 3D scene MUST show an orbit gizmo in a corner of the viewport that doubles as a compass (north
for geographic scenes, the layout's reference direction otherwise). Clicking the north mark MUST
restore heading 0°; clicking the top face MUST enter Map mode; clicking a side face MUST select the
front or side preset; dragging the gizmo MUST orbit. The gizmo MUST be keyboard reachable with `F6`
(INT-015), with arrow keys choosing a preset and `Enter` applying it.

*Acceptance:* After rotating with `Q`, clicking north restores heading 0° in ≤ 250 ms; clicking the
top face enters Map mode and the camera can no longer tilt; with the keyboard only, `F6` to the gizmo,
an arrow and `Enter` apply the side preset.

#### INT-044 — Altitude ladder
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Every 3D estate scene MUST show an altitude ladder with rungs L0–L5 ([15](15-estate-navigation.md)
Table 15-2) marking the camera's current level, updated continuously during flights. Clicking a rung
MUST fly to that level over the focused entity's ancestor or descendant on that rung, within the
camera-transition budget (PRF-007).

*Acceptance:* Given a node building framed at L3, then rung L3 is lit; clicking L1 flies to its
region plateau in ≤ 250 ms and lights L1; during a semantic-zoom flight the lit rung changes at each
level crossing.

## 6. Time as a dimension

Time is the one axis every signal shares. The Context time window is shown and set in the page
header's time range picker ([02](02-information-architecture.md) IA-020) and manipulated directly on
every time chart. Space scenes (Atlas, Lens) add the **Time Ribbon** (IA-028), drawn below: an
overview strip with the active window as a brush.

```
 ┌─────────────────────────────────────────────────────────────────────────────────────────────┐
 │ ◀◀  ▶  ● LIVE │ ░░▒▒░░░░▒▓█▓▒░░░░░░░░▒▒░░░░░░░░░░░▕████ active window ████▏░░▒░  │ 12:03–13:03 │
 │               │  ▲deploy v2.31   ▲alert:HighLatency            ▲you are here       │ vs ⟲ -7d ▾  │
 └─────────────────────────────────────────────────────────────────────────────────────────────┘
   overview strip = anomaly density across the whole (zoomable) history; events as glyphs
```

[mockup](../mockups/06-metrics-workbench.svg)

#### INT-025 — Window brush
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business

Right-dragging, or `Alt`+left-dragging, horizontally across the plot area of any time chart MUST
brush a window that becomes the Context time window on release, shown in the header picker as an
absolute range. On the Time Ribbon
in Space scenes (from M-UI3), dragging a window edge MUST resize the active window, dragging its body
MUST move it, and the wheel over the ribbon MUST zoom the overview strip.

*Acceptance:* Brushing 12:10–12:20 on a time chart sets the Context window and the header picker to
12:10–12:20 on release; on the Ribbon, each of the three gestures changes the window or overview as
stated, and the Context time updates on release.

#### INT-026 — Global time cursor and replay
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

A single global time cursor MUST be shown on every time-based viewport; hovering in any chart MUST
move it in every chart (synchronised crosshair). In the Atlas and estate views (from M-UI3), the
cursor position MUST drive the state shown, so scrubbing replays the incident across the topology.

*Acceptance:* Hovering at 12:22 in one chart places the cursor at 12:22 in all others in the same
frame; on the storyboard replay, scrubbing from 12:15 to 12:30 shows `psp-api` turning red before
payments, checkout and gateway.

#### INT-027 — Playback
**MUST** · M-UI3 · NOC, SRE, IC

`▶` MUST replay the active window at a user-selected speed from 1× to 1000×, animating map health,
edge traffic and log-rate pulses.

*Acceptance:* Playing a 1 h window at 60× completes in 60 s ± 1 s, with health, traffic and log-rate
encodings changing over time.

#### INT-028 — LIVE mode
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

In LIVE mode (`L` or `● LIVE`), data MUST stream in and charts MUST scroll smoothly with sub-pixel
motion, not step-wise jumps on each refresh interval.

*Acceptance:* In a frame capture of a LIVE chart, the x offset advances every frame by a sub-pixel
amount consistent with wall-clock time, with no jump larger than 1 px.

#### INT-029 — A/B windows and A/B Everything
**MUST** · M-UI6 · SRE, Engineer, Platform

The time controls (the header time range picker, and the Time Ribbon in Space scenes) MUST hold an A
window and a B window (−1d, −7d, before deploy ◆, previous version, or any brush). `C` MUST put the entire scene into A-vs-B diff mode ([05](05-visualisation-catalogue.md)).

*Acceptance:* Setting B to "before deploy ◆ v2.31" and pressing `C` shows every viewport in the scene
as an A-vs-B diff; pressing `C` again restores normal mode.

#### INT-030 — Comparison baseline ghost
**MUST** · M-UI1 · SRE, Engineer, Platform

`Shift+C` MUST toggle a ghost overlay of an earlier period (−1d, −7d, "before deploy X", or custom)
on the focused viewport, rendered as a translucent band with colour-coded deltas. It MUST work in
every visualisation, including flame graphs (as a diff flame, from M-UI2) and the Atlas (as deviation
glow, from M-UI3).

*Acceptance:* `Shift+C` on a p99 chart with baseline −7d shows the −7d band and colour-coded deltas;
on a flame graph it shows a diff flame; on the Atlas it shows deviation glow.

#### INT-031 — Events on the time axis
**MUST** · M-UI1 · SRE, Engineer, Platform, NOC

Events (deploys, config changes, alert transitions, annotations) MUST render as vertical markers
across every time viewport, and as glyphs on the Time Ribbon in Space scenes (from M-UI3); clicking
one MUST set a before/after comparison around it.

*Acceptance:* The v2.31 deploy shows a marker on every time chart (and ◆ on the Ribbon in a Space
scene); clicking it
sets the baseline to the window before the deploy and the current window after it.

#### INT-032 — Window step and zoom keys
**MUST** · M-UI1 · SRE, Engineer, Platform, NOC

`[` / `]` MUST step the window back / forward by one window width, and `-` / `=` MUST zoom the window
out / in by a factor of 2 around its centre.

*Acceptance:* With 12:03–13:03, `[` gives 11:03–12:03, `-` gives 11:33–13:33, and `=` restores
12:03–13:03.

## 7. Selection, inspection, pivot

The same pattern applies in every visualisation.

```
┌ Inspector: checkout · p99 latency · 13:41:20 ───────────────┐
│ 2.84 s  (▲ 7.1× vs −7d)                                     │
│ service.name=checkout  k8s.pod.name=checkout-7f9c-2xq       │
│──────────────────────────────────────────────────────────── │
│ Pivot ▸ [Traces in this bucket ⟶] [Logs ±1m ⟶] [Profile ⟶]  │
│         [Upstream callers ⟶] [Same metric, all pods ⟶]      │
│ Actions ▸ [Pin to investigation] [Create alert] [Ask AI ✦]  │
│ Query ▸ histogram_quantile(0.99, sum by (le) (rate(…)))  ✎  │
└─────────────────────────────────────────────────────────────┘
```

#### INT-033 — Hover tooltip
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support

Hover MUST show a lightweight tooltip with the value, labels and delta vs baseline, in every
visualisation.

*Acceptance:* Hovering a point on a line chart, a heatmap cell and an Atlas node each shows value,
labels and Δ vs baseline within one frame (PRF-003).

#### INT-034 — Click selects and opens the Inspector
**MUST** · M-UI2 · SRE, Platform, Engineer

Click MUST select, and the Inspector MUST show for the selection: labels/attributes, raw values, the
underlying query (editable, ✎), pivot chips and actions (Pin to investigation, Create alert, Ask AI).

*Acceptance:* Clicking the p99 series at 13:41:20 opens the Inspector with all five sections as in
the sketch.

*Staging (#164, [T25](../technical/T25-inspector-and-pivots.md#t25-015--actions-staged)):* the M-UI2 acceptance is the five sections, with
Pin, Create alert and Ask AI disabled and their reasons shown; they work with
[IA-007](02-information-architecture.md#ia-007--investigations),
[ALR-010](07-alerting.md#alr-010--create-alert-from-every-inspector) and
[AI-030](06-ai-copilot.md#ai-030--ask-ai-from-the-inspector) (M-UI4), whose acceptance covers them.

#### INT-035 — Pivot chips keep Context
**MUST** · M-UI2 · SRE, Platform, Engineer

Pivot chips MUST be context-aware jumps (e.g. traces in this bucket, logs ±1 min, profile, upstream
callers, same metric on all pods) that keep Context under the rules of
[02](02-information-architecture.md) §5.

*Acceptance:* "Logs ±1m" from the p99 point at 13:41:20 opens logs for `checkout` from 13:40:20 to
13:42:20 with translated filters and the same baseline.

*Staging (#164, [T25](../technical/T25-inspector-and-pivots.md#t25-010--pivot-context)):* interim (I1): time and filters are kept as
T25-010 states, and the chip's Context line reads "Not carried yet: baseline". The baseline is
carried, with the line gone, from I6 (the Context baseline,
[INT-030](#int-030--comparison-baseline-ghost)); the example acceptance above applies there
(`unit:pivot-context` rows C3 and C4).

#### INT-036 — Pivot opens as a split
**MUST** · M-UI2 · SRE, Platform, Engineer

A pivot MUST open the target as a split view (side by side, sharing the time cursor) by default;
`Shift`-click MUST replace the current view; `⌘`-click MUST open it in a new browser tab. `\` MUST
toggle a split of two linked views.

*Acceptance:* Clicking "Traces in this bucket" opens traces beside the chart, hover in either moves
the shared cursor; `Shift`-click replaces the chart; `⌘`-click opens a new tab with the same Context.

*Staging (#164, [T25](../technical/T25-inspector-and-pivots.md#t25-009--pivot-chips)):* interim (I1): plain click and `Shift`-click replace
the view, Back returns, and `⌘`/`Ctrl`-click opens a new tab (`e2e:inspector-pivot-nav`); I4 (M-UI2)
adds the default split and `\`, and the full acceptance above applies there.

## 8. Command palette

One fuzzy box for everything.

| Category | Examples | Behaviour |
|---|---|---|
| Entities | "checkout", "pod checkout-7f9c", "node ip-10-2-3-4" | Fly to the entity |
| Boards, investigations, alerts, waypoints | "INV-2041", "checkout overview" | Open it |
| Actions | "compare with last week", "silence this alert 1h", "toggle 3D", "export PNG", "view as…" | Run it on the current Context |
| Queries | Input starting `rate(` → PromQL · `{app=` → LogQL · `{ span.` → TraceQL · `process_cpu:` → profile selector | Open the matching workbench with the query |
| Natural language | Anything else, or a `?` prefix ("why is checkout slow") | Send to the AI copilot ([06](06-ai-copilot.md)) |

[mockup](../mockups/15-command-palette.svg)

#### INT-037 — Palette covers everything
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

`⌘K` MUST open a single fuzzy search over every category in the table above, as each category's
objects become available (entities from M-UI2, investigations and alerts from M-UI4, boards from
M-UI5).

*Acceptance:* At M-UI5, typing "checkout" lists the entity, its boards, open alerts and
investigations in one result list.

#### INT-038 — Query detection
**MUST** · M-UI1 · Platform, Engineer, SRE

Palette input that starts like PromQL (`rate(`), LogQL (`{app=`), TraceQL (`{ span.`) or a profile
selector (`process_cpu:`) MUST open the matching workbench with that query.

*Acceptance:* Each of the four prefixes opens the Metrics, Logs, Traces or Profiles workbench
respectively with the typed query in its editor.

#### INT-039 — Natural language goes to the AI
**MUST** · M-UI4 · SRE, Engineer, Business, Support, IC

Input that matches no other category, or that starts with `?`, MUST be sent to the AI copilot with the
current Context.

*Acceptance:* "why is checkout slow" opens the copilot dock with that question and the current
Context attached.

#### INT-040 — Palette ranking
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer

Results MUST be ranked by recency, anomaly score and relevance to the current Context.

*Acceptance:* With `checkout` failing and `cart` healthy and both equally recent, "c" ranks
`checkout` first; with the Context on `cart`, `cart` ranks first.

## 9. Undo everywhere

#### INT-041 — Undo stack
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business

Context changes (time brush, filter add, entity narrow) and Board edits MUST be on an undo stack with
`⌘Z` (undo) and `⌘⇧Z` (redo), so exploration never feels risky.

*Acceptance:* Brushing a window, adding a filter and narrowing to a pod, then `⌘Z` three times,
restores the original Context; `⌘⇧Z` re-applies each step.

## 10. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| INT-001 | Camera per scene and camera modes | MUST | M-UI3 |
| INT-002 | Cursor-anchored zoom | MUST | M-UI0 |
| INT-003 | Inertia | MUST | M-UI0 |
| INT-004 | Smooth programmatic transitions | MUST | M-UI1 |
| INT-005 | No motion sickness | MUST | M-UI3 |
| INT-006 | Camera history | MUST | M-UI1 |
| INT-007 | Mouse and trackpad bindings | MUST | M-UI1 |
| INT-008 | Per-axis pan, zoom and fit | MUST | M-UI1 |
| INT-009 | Keyboard bindings | MUST | M-UI1 |
| INT-010 | No key bound to two actions in one context | MUST | M-UI1 |
| INT-011 | Tap and hold | MUST | M-UI1 |
| INT-012 | Chords | MUST | M-UI1 |
| INT-013 | Remappable bindings and presets | MUST | M-UI5 |
| INT-014 | Shortcut overlay | MUST | M-UI1 |
| INT-015 | Keyboard focus is never trapped | MUST | M-UI1 |
| INT-016 | Esc and Enter ladder | MUST | M-UI2 |
| INT-017 | Time scrub | MUST | M-UI1 |
| INT-018 | Gamepad and 3D mouse | MAY | M-UI6 |
| INT-019 | Touch gestures | SHOULD | M-UI4 |
| INT-020 | The semantic-zoom ladder | MUST | M-UI3 |
| INT-021 | Continuity across levels | MUST | M-UI3 |
| INT-022 | Pre-fetch on approach | MUST | M-UI2 |
| INT-023 | Reversible zoom | MUST | M-UI2 |
| INT-024 | Semantic zoom in 2D charts | MUST | M-UI2 |
| INT-025 | Window brush | MUST | M-UI1 |
| INT-026 | Global time cursor and replay | MUST | M-UI1 |
| INT-027 | Playback | MUST | M-UI3 |
| INT-028 | LIVE mode | MUST | M-UI1 |
| INT-029 | A/B windows and A/B Everything | MUST | M-UI6 |
| INT-030 | Comparison baseline ghost | MUST | M-UI1 |
| INT-031 | Events on the time axis | MUST | M-UI1 |
| INT-032 | Window step and zoom keys | MUST | M-UI1 |
| INT-033 | Hover tooltip | MUST | M-UI1 |
| INT-034 | Click selects and opens the Inspector | MUST | M-UI2 |
| INT-035 | Pivot chips keep Context | MUST | M-UI2 |
| INT-036 | Pivot opens as a split | MUST | M-UI2 |
| INT-037 | Palette covers everything | MUST | M-UI1 |
| INT-038 | Query detection | MUST | M-UI1 |
| INT-039 | Natural language goes to the AI | MUST | M-UI4 |
| INT-040 | Palette ranking | MUST | M-UI1 |
| INT-041 | Undo stack | MUST | M-UI1 |
| INT-042 | Orbit constraints | MUST | M-UI3 |
| INT-043 | Orbit gizmo and compass | MUST | M-UI3 |
| INT-044 | Altitude ladder | MUST | M-UI3 |

## 11. Resolved during formalisation

1. **`C` vs `Shift+C`.** The draft's §4 called the comparison baseline "`C`", while the key table
   bound `C` to A/B Everything and `Shift+C` to the baseline ghost. Resolved as the table:
   `Shift+C` = baseline ghost (M-UI1), `C` = A/B Everything (M-UI6).
2. **`W A S D` vs `Shift+A` and `D`.** The draft bound `WASD` (+`Shift` fast) to pan everywhere, which
   collides with `Shift+A` (acknowledge) and `D` (hold, draw-to-ask). Resolved: `WASD` is bound only
   in the **Fly** context; outside Fly, keyboard panning uses the arrow keys (+`Shift` fast). In Fly,
   `Shift+A` and `D` are overridden (†) for movement; acknowledge and draw-to-ask are unavailable
   until Fly is exited with `Esc` or `` ` ``.
3. **`E` rotate vs `E` Board edit mode.** [04](04-surfaces.md) binds `E` to Board edit mode, which
   collides with `Q`/`E` rotate. Resolved: Board edit mode is `Shift+E` (or the Edit button), so `E`
   always rotates in 3D, including 3D viewports inside a Board. This matches [04](04-surfaces.md).
4. **`Alt+7`.** The draft listed seven estate views for `Alt+1`–`Alt+7`; [15](15-estate-navigation.md)
   has six and adds Timeline only in the Alerts room. Resolved: `Alt+1`–`Alt+6` in every estate view
   (`Alt+6` is Explorer, shown as List in the Alerts room); `Alt+7` Timeline only in the Alerts room.
5. **`/` focus vs find.** The draft bound `/` to "focus the query/filter bar"; [15](15-estate-navigation.md)
   uses `/` for find with `n`/`N`. Resolved: `/` focuses the scene's find/filter bar (the query bar
   in workbenches), and `n`/`N` step through its matches.
6. **Missing bindings.** `T` (3D ↔ 2D, from [05](05-visualisation-catalogue.md)), `Shift+T` (table
   view, from [05](05-visualisation-catalogue.md)) and `Shift+E` (Board edit, from [04](04-surfaces.md))
   were used elsewhere but absent from the key table; added.
7. **Tap vs hold threshold** was unspecified for `.`, `V`, `D` and `Space`. Set at 250 ms (INT-011).
8. **Chord timeout** for `g` was unspecified. Set at 1 s (INT-012).
9. **Keyboard trap.** `Tab` cycling inside the canvas would trap keyboard-only users; `F6` /
   `Shift+F6` region navigation added (INT-015).
10. **Esc in Fly.** The `Esc` ladder now starts with "exit Fly".
11. **Right mouse in 3D.** Right drag pans; right button held with `W`/`A`/`S`/`D` flies while held.
12. **Shift+digit on non-US layouts.** Bindings match the physical key position (INT-013).
13. **3D-first estate (1.0-rc2).** The owner's brief is 3D, game-like navigation on the GPU. Map
    mode is no longer the default for very large estates; Orbit is the default in every 3D scene
    (INT-001), and Map is entered from the gizmo or palette. No new keys were added: `Q`/`E`,
    `Home`, `V`, `Alt+1`–`Alt+6` and `` ` `` keep their meanings; camera presets use the gizmo
    (INT-043) and the altitude ladder is pointer- and `F6`-reachable (INT-044).
14. **Wheel in 3D signal views (1.0-rc2).** Wheel, `Shift`+wheel and `Alt`+wheel zoom the time,
    value and lane-depth axes, matching the 2D per-axis model; `Alt`+wheel was unbound in every
    context, so no conflict arises.
15. **Product names (1.0-rc2).** A third-party product name in the Fly row of the camera table was
    replaced by "game-editor style".

## 12. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft |
| 1.0-rc2 | 2026-11-18 | 3D-first estate per owner brief: §3 camera table and INT-001 edited (Orbit default everywhere, Map on request); §4.1 wheel and double-click rows for 3D scenes and 3D signal views; §5 continuous infrastructure flight; §5.1 INT-042 to INT-044 added; resolutions 13–15 |
| 1.1-rc | 2026-11-19 | Application layout (D9, roadmap Q13): the time window lives in the page header ([02](02-information-architecture.md) IA-020) and the Time Ribbon only in Space scenes (IA-028); §6 intro, INT-015 (F6 regions), INT-017, INT-025 (brush on any time chart), INT-029 and INT-031 revised in place; key table `F6` row |
| 1.2-rc | 2026-11-21 | #93, owner decisions 2026-11-21: §4.1 2D double-click zooms the window out; note on time commits, the local value axis, wheel over the plot only, pinch heuristic, right click on the plot; INT-025 brushes by right drag or Alt+left drag (left drag pans) |
| 1.3-rc | 2026-11-25 | #164 ([T25](../technical/T25-inspector-and-pivots.md)): INT-034, INT-035 and INT-036 gain staging notes with interim acceptance and their delivering issues (M-UI4 actions; I6 baseline; I4 split and `\`); INT-016 note: a kind's steps go before and after the host's (T25-007) |
| 1.4-rc | 2026-11-25 | #184 ([T24](../technical/T24-geo-schematic-and-widget-panels.md) part E step 1b): INT-001 note (a 2D map has one zoom for both axes in one unrepeated world, ADR-0027); §4.1 note on the 2D map's wheel, drag, right drag, `Alt`+drag and double-click |
