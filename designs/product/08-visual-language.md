# 08 — Visual language

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.2-rc · 2026-11-20 |
| **Requirement area** | `VL` |
| **Source draft** | plans/08-visual-language.md (not tracked) |
| **Depends on** | [01a](01a-audiences-and-perspectives.md), [03](03-interaction-model.md), [05](05-visualisation-catalogue.md), [09](09-performance-contract.md), [T02](../technical/T02-vis-engine.md), [T08](../technical/T08-dom-component-kit.md) |
| **Mockups** | [mockups/README](../mockups/README.md) (tokens as used in mockups), [34-application-layout](../mockups/34-application-layout.svg), [01-landscape-map](../mockups/01-landscape-map.svg), [22-topology-3d](../mockups/22-topology-3d.svg), [16-gallery](../mockups/16-gallery.svg), [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg), [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg), [20-city-cluster-3d](../mockups/20-city-cluster-3d.svg), [21-floors-3d](../mockups/21-floors-3d.svg), [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg) |

## 1. Purpose & scope

This document fixes the visual language shared by the GPU canvas and the DOM rooms: character,
colour, redundant state encoding, typography and number formatting, motion, layout and chrome,
iconography and glyphs, and the design-token pipeline. It is the source of the tokens that the
mockups use.

**Character: calm instrument, not a light show.** Think flight-deck glass cockpit meets a
well-designed strategy game: dark, quiet, precise; colour and motion reserved for meaning. A healthy
estate should look almost monochrome. When something goes wrong, it should be impossible to miss
(see AUD-037 in [01a](01a-audiences-and-perspectives.md)).

**Space is 3D, signals are 2D.** The estate is a lit 3D world of plateaus and buildings (§10); signal
charts are flat and precise. Both use the same tokens, and the 3D world keeps the calm-instrument
character: one light, fog, hairline grid, no decoration ([05](05-visualisation-catalogue.md) VIZ-077,
[15](15-estate-navigation.md) EST-064).

## 2. Definitions

| Term | Meaning |
|---|---|
| **Token** | A named design value (colour, space, type, motion) defined once in the token file |
| **Semantic state colour** | A colour reserved for one of the five health states |
| **Series palette** | The categorical colours for ordinary data series |
| **Deviation glow** | Additive bloom whose intensity is proportional to anomaly score |
| **Density mode** | Comfortable, Compact or Wall type and spacing scale |
| **Mark** | A GPU drawing primitive (line, area, point, cell, node, edge, glyph, text, box) |
| **Depth cue** | A 3D shading aid that carries no data and no hue: key + ambient lighting, depth fog, ground grid and contact shadows (§10) |
| **Beacon** | A vertical column of light marking the probable origin ⊕ in a 3D scene |

## 3. Colour

### 3.1 Tokens (dark theme)

| Token | Value | Token | Value |
|---|---|---|---|
| `canvas` | `#0B0D10` | `surface-1` | `#12151A` |
| `surface-2` | `#191D24` | `hairline` | `#FFFFFF` at 8% (`#FFFFFF14`) |
| `text` | `#E6E8EB` | `text-muted` | `#8A919C` |
| `ok` | `#2FB59A` (teal-green) | `watch` | `#D9C84A` (cool yellow) |
| `degraded` | `#E8923A` (amber) | `failing` | `#E0457B` (red-magenta) |
| `unknown` | `#6B7280` + hatch (hatched grey) | `accent` / `focus` | `#5B9BFF` |
| `series-1`…`series-8` | `#7AA2D6` `#C9A36B` `#8FBF8F` `#B48FC9` `#6FB8B8` `#C98F8F` `#A8A8D9` `#BFB07A` | | |

#### VL-001 — Dark-first themes, both designed
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

The default theme MUST be dark, using the canvas and layered surface tokens above. From M-UI5, a
full light theme for daytime offices and printing MUST also be provided, designed with its own token
values rather than produced by inverting the dark theme.

*Acceptance:* A fresh session renders with `canvas` `#0B0D10` and surfaces `#12151A` / `#191D24`;
switching to light renders every surface, text, state and series token from the light token set, and
no light value is the arithmetic inverse of its dark value.

#### VL-002 — Neutral series palette with stable identity colours
**MUST** · M-UI1 · Platform, Engineer, SRE

Ordinary series MUST use the eight-hue desaturated `series-1`…`series-8` palette, validated for
colour-vision-deficiency (CVD) distinguishability and equal perceived lightness. A series' colour
MUST be chosen by a stable hash of its identity, so the same pod has the same colour on every chart.

*Acceptance:* The palette validator reports all eight hues within ±3 L* of each other and pairwise
distinguishable under deuteranopia, protanopia and tritanopia simulation; the same pod series has
the same colour in two different charts and after reload.

#### VL-003 — State colours are reserved for health
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

The semantic state colours (`ok`, `watch`, `degraded`, `failing`, `unknown`) MUST be used only to
encode health state ([01a](01a-audiences-and-perspectives.md) §4.2) and MUST NOT be used for ordinary
series.

*Acceptance:* A lint of every visualisation spec and DOM stylesheet finds the state tokens only on
health encodings; the series palette contains none of them.

#### VL-004 — Deviation glow is the only effect
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business

Deviation MUST be shown as an additive bloom whose intensity is proportional to the anomaly score.
It is the only visual "effect" allowed, because it carries information; no decorative glow, shadow
or bloom MAY be used. The depth cues of §10 (lighting, fog, ground grid, contact shadows) are shading
in 3D scenes, not effects; they MUST NOT add hue or glow.

*Acceptance:* Two entities with anomaly scores 0.4 and 0.8 render glows whose measured intensity
ratio is 1 : 2 (±10%), in 2D and in 3D scenes; an entity with score 0 has no glow; no other bloom
appears in any frame capture.

#### VL-005 — Victims and origin
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Victims MUST be rendered desaturated with a dashed ring; the probable origin MUST be rendered at full
saturation with the ⊕ glyph ([01a](01a-audiences-and-perspectives.md) AUD-006). In 3D scenes the
victim's dashed ring MUST lie on the ground around its footprint, and the origin MUST additionally
carry a vertical light beacon in its state colour rising from its top face to above the tallest
building in view, visible from any heading.

*Acceptance:* As AUD-006; the victim fill saturation is ≤ 50% of the origin's; in the 3D infra city
the origin's beacon is visible after a 360° orbit at every heading, and each victim shows a dashed
ground ring.

#### VL-006 — Ramps
**MUST** · M-UI1 · Platform, Engineer, SRE

Sequential ramps (heatmaps) MUST be perceptually uniform (viridis/magma-like) and single-hue for
density. Diverging ramps (blue ↔ red) MUST be used only for deltas.

*Acceptance:* A heatmap of density uses a single-hue uniform ramp; a diff (e.g. diff flame, A/B
delta) uses the diverging ramp; no non-delta visualisation uses the diverging ramp.

## 4. Shape and redundancy (accessibility)

State is always encoded twice: colour **and** glyph/ring style.

| State | Colour token | Glyph |
|---|---|---|
| OK | `ok` | ● |
| Watch | `watch` | ◐ |
| Degraded | `degraded` | ◉ |
| Failing | `failing` | ■ |
| Unknown | `unknown` + hatch | ○ |

| Ring style | Meaning |
|---|---|
| Solid | Normal / origin |
| Dashed | Victim |
| Pulsing (1 Hz, low amplitude) | Active, un-acknowledged alert |

#### VL-007 — State is always encoded twice
**MUST** · M-UI2 · NOC, SRE, Platform, Engineer, Business, Support, IC

Every health state MUST be encoded by both its colour token and its glyph from the table above, and
ring style MUST follow the ring table; Unknown MUST be hatched.

*Acceptance:* Rendered in greyscale, every state in the Atlas, breadcrumb, board tile, alert list and
NOC wall remains identifiable by glyph or ring alone.

#### VL-008 — CVD-safe palettes and wall high contrast
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

All palettes MUST pass deuteranopia, protanopia and tritanopia simulation. Wall mode MUST use a
high-contrast variant of the palette (from M-UI6).

*Acceptance:* The palette validator passes all three simulations for the state and series palettes in
both themes; the Wall variant achieves ≥ 7:1 contrast for text and ≥ 3:1 for state marks against
`canvas`.

#### VL-009 — Accessible contrast in both themes
**MUST** · M-UI6 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

Text and interactive elements MUST meet WCAG 2.2 AA contrast in both themes, on the canvas and in the
rooms, verified by an accessibility audit.

*Acceptance:* Automated contrast checks find no text below 4.5:1 (3:1 for large text) and no UI
component boundary below 3:1 in either theme; the M-UI6 AA audit passes.

## 5. Typography and numbers

| Use | Font | Notes |
|---|---|---|
| UI | Inter (variable) | Tabular numerals wherever numbers align |
| Data and code (logs, queries, labels) | JetBrains Mono | — |
| Sizes | 11 / 12 / 13 / 16 / 20 px | Compact scale; Wall is ×1.6 |

| Density mode | Use |
|---|---|
| Comfortable | Business, Support, first-time users |
| Compact | Default for engineers |
| Wall | ×1.6 type scale, for NOC walls |

#### VL-010 — Fonts
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

UI text MUST use Inter with tabular numerals wherever numbers align; data and code (logs, queries,
labels) MUST use JetBrains Mono. Both fonts MUST be self-hosted with the application.

*Acceptance:* Every UI string renders in Inter and every log, query and label in JetBrains Mono;
numeric columns align digit for digit; no font is fetched from a third-party host.

#### VL-011 — Canvas text matches DOM text
**MUST** · M-UI0 · NOC, SRE, Platform, Engineer, Business, Support, IC

GPU text MUST use MSDF atlases of the same fonts, so canvas text and DOM text match exactly.

*Acceptance:* The same string at the same size rendered on the canvas and in the DOM differs by
≤ 1 px in advance width and baseline position.

#### VL-012 — Numbers for humans
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Numbers MUST be formatted for humans with SI prefixes and units (e.g. `2.84 s`, `1.2k rps`,
`€38k/h`), and times as relative with absolute on hover (e.g. `since 12:22 (40 min)`).

*Acceptance:* A value of 2 843 ms renders `2.84 s`; 1 204 requests/s renders `1.2k rps`; 38 000 €/h
renders `€38k/h`; an onset 40 minutes ago at 12:22 renders `since 12:22 (40 min)` and hovering shows
the full absolute timestamp.

#### VL-013 — Density modes
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support

Comfortable and Compact density modes MUST be available, with Compact the default for engineers.
Wall mode (×1.6 type scale) MUST be available from M-UI6.

*Acceptance:* Switching density changes type size and spacing across canvas and DOM; a new Engineer
Perspective user starts in Compact; Wall mode renders 13 px body text at 20.8 px.

## 6. Motion

| Motion | Spec |
|---|---|
| Camera transitions | ≤ 250 ms, ease-out |
| Data crossfade on refresh | 150 ms |
| Active-alert ring pulse | 1 Hz, low amplitude |
| Traffic | Edge particles |
| Loading | No spinners on data; thin progress shimmer on the viewport edge only after 300 ms |
| Semantic-zoom flight (3D) | Continuous, each leg ≤ 250 ms, ease-out ([15](15-estate-navigation.md) EST-060) |
| `prefers-reduced-motion` | Instant cuts; particles replaced by static dashes with thickness; estate opens in its 2D equivalent ([15](15-estate-navigation.md) EST-063) |

#### VL-014 — Purposeful motion only
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Motion MUST be limited to the kinds in the table, with the durations and rates stated there; there
MUST be no bouncing and no decorative animation.

*Acceptance:* Frame captures show camera transitions ≤ 250 ms with ease-out, refresh crossfades of
150 ms ± 1 frame, alert rings pulsing at 1 Hz, and no other animation.

#### VL-015 — No spinners on data
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Data loading MUST be shown by progressive refinement (coarse data sharpens), never by a spinner. A
thin progress shimmer on the viewport edge MAY appear, and only once a load has taken > 300 ms.

*Acceptance:* With a 1 s server delay, the viewport shows cached or coarse data, no spinner, and a
shimmer appearing 300 ms after the request and disappearing when refined.

#### VL-016 — Reduced motion
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

With `prefers-reduced-motion` set, transitions MUST be instant cuts and traffic particles MUST be
replaced by static dashes whose thickness encodes traffic.

*Acceptance:* With `prefers-reduced-motion: reduce`, a dive shows the final pose on the next frame;
Atlas edges show static dashes whose thickness increases with request rate; no element animates
except the alert ring, which is shown as a static double ring.

## 7. Layout and chrome

| Token | Value |
|---|---|
| Sidebar width | 240 px expanded; 56 px collapsed (icon rail) |
| Page header height | 56 px |
| Page content padding | 24 px |
| Board panel gap | 16 px |
| Time Ribbon height (Space scenes) | 40 px |
| Base grid | 4 px |
| Viewport gutter (inside dense views: Lens strips, small multiples) | 8 px |
| Corner radius | 6 px |
| Hairline border | 1 px at 8% contrast (`hairline`) |

#### VL-017 — Application layout dimensions
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

The application layout ([02](02-information-architecture.md) IA-016) MUST use the sizes of the table
above: a 240 px sidebar that collapses to a 56 px icon rail, a 56 px page header, 24 px page content
padding and 16 px gaps between board panels, so boards stay roomy. The sidebar and page header are
opaque `surface-1` with a 1 px `hairline` edge; the sidebar's top block is 56 px high, so its bottom
hairline continues the page header's. A long page title truncates with an ellipsis before any header
control moves or the page scrolls sideways. The time range trigger adds the absolute window of a
relative range (for example `12:03 – 13:03 GMT`) only when the viewport is at least 1520 px wide. In
Space scenes the Time Ribbon is 40 px and, like the minimap, translucent over the canvas.

*Acceptance:* At 1440×900 the expanded sidebar is 240 px wide and 56 px when collapsed, the page
header is 56 px high with the sidebar's top block ending on the same line, the content padding is
24 px and board panels are 16 px apart; with the 240 px sidebar, a board with a long title shows it
truncated with an ellipsis and the page does not scroll sideways; the absolute window shows at
1520 px and not at 1519 px; in a Space scene the Ribbon is 40 px high and canvas content is visible
through it.

#### VL-018 — Floating, dockable panels
**MUST** · M-UI2 · SRE, Platform, Engineer

The Inspector, AI dock and query editor MUST be floating panels that users can dock and arrange, like
an IDE; the arrangement MUST persist per user.

*Acceptance:* Docking the Inspector left and floating the query editor persists after reload.

#### VL-019 — Layout grid
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC, Admin

Layout MUST use the 4 px base grid, 8 px viewport gutters inside dense views, 16 px gaps between
board panels (VL-017), 6 px corner radius and 1 px hairline borders at 8% contrast, in canvas and DOM
alike.

*Acceptance:* A layout audit of the Atlas, a Board and each room finds every position and size a
multiple of 4 px, gutters of 8 px inside dense views and 16 px between board panels, radii of 6 px and
borders of 1 px `hairline`.

## 8. Iconography and glyphs

The icon set is single-weight line. The glyph language is fixed across the product:

| Glyph | Meaning |
|---|---|
| ◆ | Deploy |
| ⚙ | Config change |
| ⚑ | Feature flag |
| ⚠ | Alert |
| ⊕ | Probable origin |
| ✚ | Investigation |
| ✦ | AI |
| ⟶ | Pivot |

State glyphs are in §4.

#### VL-020 — Fixed glyph language
**MUST** · M-UI1 · NOC, SRE, Platform, Engineer, Business, Support, IC

Each glyph in the table MUST mean only its listed meaning everywhere in the product, and icons MUST
come from one single-weight line set.

*Acceptance:* A review of every surface finds each glyph used only for its listed meaning and no icon
from another set.

## 9. Design-system deliverables

#### VL-021 — One token source for canvas and DOM
**MUST** · M-UI0 · Platform, Engineer

Colour, space, type and motion tokens MUST be defined once in a single token file, from which the
CSS custom properties and TS constants of the web application and the Rust constants of the chart
engine are generated ([ADR-0014](../adr/0014-typescript-react-web-client.md) §6).

*Acceptance:* Changing `accent` in the token file and rebuilding changes the focus colour on the
canvas and in every room; a CI check fails if a hard-coded colour appears outside the generated
outputs.

#### VL-022 — Component and mark libraries share the tokens
**MUST** · M-UI1 · Platform, Engineer

The DOM rooms MUST use one component library ([T08](../technical/T08-dom-component-kit.md)), and the
GPU renderer MUST use a mark library (line, area, point, cell, node, edge, glyph, text;
[T02](../technical/T02-vis-engine.md)); both MUST consume only the generated tokens.

*Acceptance:* Every room is built from the component kit and every visualisation from the mark
library, and neither defines a colour, size or duration outside the token outputs.

## 10. 3D scenes

The 3D world is drawn with a deliberately small set of depth cues, so that it reads as a precise
instrument, not a game skin. Mockups: [19-estate-3d-landscape](../mockups/19-estate-3d-landscape.svg),
[20-city-cluster-3d](../mockups/20-city-cluster-3d.svg), [24-noc-wall-3d](../mockups/24-noc-wall-3d.svg).

| Token | Value (dark theme) |
|---|---|
| `ground` | `canvas` (`#0B0D10`) |
| `ground-grid` | `hairline` (`#FFFFFF14`) |
| `fog` | `canvas`, linear from 55 % to 100 % of the far plane, maximum 70 % |
| `light-key` | One directional light, elevation 55°, azimuth 45° left of the camera heading |
| `light-ambient` | 45 % of key intensity |
| `face-top` / `face-side-lit` / `face-side-shade` | 100 % / 80 % / 62 % of the mark's colour luminance |
| `entity-neutral` | `#3A4048` (healthy building or plateau face) |
| `contact-shadow` | `#000000` at 35 %, radius 0.25 × footprint |

#### VL-023 — One key light and ambient
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

3D scenes MUST be lit by one directional key light plus ambient, with the light direction fixed
relative to the camera heading (`light-key`) so that the lit side is always on the same side of the
screen. Top faces MUST be the lightest and side faces darker per the `face-*` tokens. Shading MUST
change luminance only, never hue, so a state colour stays identifiable on every face.

*Acceptance:* Given a building of each state, when rendered, then top, lit-side and shaded-side
luminances are 100 % / 80 % / 62 % (±3 %) of the token, the hue angle of every face is within 2° of
the token, and every face passes the VL-008 CVD simulation against its neighbours.

#### VL-024 — Depth fog toward the horizon
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

3D scenes MUST blend distant geometry toward `canvas` with the `fog` token, so that depth reads and
the horizon dissolves. Fog MUST NOT apply to the focused, selected or origin entity, to beacons, to
labels, or to any entity in a non-OK state beyond the point where its state mark keeps ≥ 3:1 contrast
against `canvas`.

*Acceptance:* At the far plane a healthy building is blended 70 % toward `canvas`; a failing
building at the same distance keeps ≥ 3:1 contrast; the origin beacon and all labels are unfogged.

#### VL-025 — Ground plane and hairline grid
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

3D estate scenes MUST draw a ground plane in `ground` with a grid of `ground-grid` hairlines whose
spacing follows the current level (coarser at L0, finer at L3) and which fades with distance under the
fog.

*Acceptance:* The grid lines are 1 px `hairline` at every level; their world spacing changes when the
altitude ladder changes rung; no grid line is drawn beyond the fog's 70 % point.

#### VL-026 — Contact shadows only
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer

Each 3D mark standing on a surface MUST have a soft contact shadow (`contact-shadow`) directly
beneath it. Cast shadows, ambient-occlusion halos and reflections MUST NOT be drawn.

*Acceptance:* A frame capture shows a shadow of radius 0.25 × footprint under every building and none
projected onto neighbouring buildings.

#### VL-027 — 3D restraint
**MUST** · M-UI3 · NOC, SRE, Platform, Engineer, Business

3D scenes MUST NOT use skyboxes, textures (including on imported models), reflections, lens flare,
depth of field, film grain or decorative particles; traffic particles on edges are data and allowed.
Healthy entities MUST be drawn in `entity-neutral` grey, so that a healthy estate is near-monochrome
and state colour appears only where state is not OK. The deviation glow (VL-004), beacon (VL-005)
and traffic particles are the only luminous elements.

*Acceptance:* A lint of the scene spec rejects any texture, skybox or post-effect other than the
deviation glow; a frame capture of a healthy estate contains no pixel whose hue matches a non-OK
state token outside labels and glyphs.

#### VL-028 — 3D shares the 2D tokens
**MUST** · M-UI3 · Platform, Engineer

3D scenes and 3D signal views MUST take every colour, type and motion value from the same generated
tokens as 2D (VL-021), including the 3D tokens above, in both themes; the light theme MUST define its
own 3D token values.

*Acceptance:* Changing `failing` in the token file changes building faces, beacons and 2D state marks
alike; the light theme renders the 3D world with its own `ground`, `fog` and `entity-neutral` values.

## 11. Requirements summary

| ID | Title | Priority | Milestone |
|---|---|---|---|
| VL-001 | Dark-first themes, both designed | MUST | M-UI1 |
| VL-002 | Neutral series palette with stable identity colours | MUST | M-UI1 |
| VL-003 | State colours are reserved for health | MUST | M-UI1 |
| VL-004 | Deviation glow is the only effect | MUST | M-UI2 |
| VL-005 | Victims and origin | MUST | M-UI3 |
| VL-006 | Ramps | MUST | M-UI1 |
| VL-007 | State is always encoded twice | MUST | M-UI2 |
| VL-008 | CVD-safe palettes and wall high contrast | MUST | M-UI1 |
| VL-009 | Accessible contrast in both themes | MUST | M-UI6 |
| VL-010 | Fonts | MUST | M-UI1 |
| VL-011 | Canvas text matches DOM text | MUST | M-UI0 |
| VL-012 | Numbers for humans | MUST | M-UI1 |
| VL-013 | Density modes | MUST | M-UI1 |
| VL-014 | Purposeful motion only | MUST | M-UI1 |
| VL-015 | No spinners on data | MUST | M-UI1 |
| VL-016 | Reduced motion | MUST | M-UI1 |
| VL-017 | Application layout dimensions | MUST | M-UI1 |
| VL-018 | Floating, dockable panels | MUST | M-UI2 |
| VL-019 | Layout grid | MUST | M-UI1 |
| VL-020 | Fixed glyph language | MUST | M-UI1 |
| VL-021 | One token source for canvas and DOM | MUST | M-UI0 |
| VL-022 | Component and mark libraries share the tokens | MUST | M-UI1 |
| VL-023 | One key light and ambient | MUST | M-UI3 |
| VL-024 | Depth fog toward the horizon | MUST | M-UI3 |
| VL-025 | Ground plane and hairline grid | MUST | M-UI3 |
| VL-026 | Contact shadows only | MUST | M-UI3 |
| VL-027 | 3D restraint | MUST | M-UI3 |
| VL-028 | 3D shares the 2D tokens | MUST | M-UI3 |

## 12. Resolved during formalisation

1. **Five states, four glyphs.** The draft listed four state glyphs (● ◐ ◉ ○) for five states, and
   [01a](01a-audiences-and-perspectives.md) showed both Degraded and Failing as ●, so the two were
   distinguishable by colour only, which breaks "state is always encoded twice". Resolved: OK ●,
   Watch ◐, Degraded ◉, Failing ■, Unknown ○ hatched. The mockup conventions should adopt ■.
2. **Pulsing ring vs `prefers-reduced-motion`.** The alert pulse is kept in normal motion and
   replaced by a static double ring under reduced motion.
3. **Hex values.** The draft named state colours only by hue; the hex values used in the mockup
   conventions are adopted as the normative dark-theme tokens.
4. **Type sizes.** The 11/12/13/16/20 px scale from the mockup conventions is adopted; Wall applies
   ×1.6.
5. **Accessibility level.** The draft required CVD simulation but no contrast level; the roadmap's
   M-UI6 "a11y AA audit" is formalised as WCAG 2.2 AA (VL-009), and the Wall variant as ≥ 7:1 text
   contrast.
6. **Fonts hosting.** Self-hosting is required (VL-010) to support air-gapped deployments
   ([11](11-enterprise.md)).
7. **Light theme values.** The draft requires a designed light theme but gives no values; the
   light token set is to be delivered with the token file (VL-021) and is open design work.
8. **3D-first estate (1.0-rc2).** The owner's brief is a GPU-rendered 3D estate. The 3D visual
   language (§10, VL-023 to VL-028) adds lighting, fog, a ground grid and contact shadows as
   hue-free depth cues; VL-004 now states that these are not "effects". VL-005 adds the origin
   beacon and the victim ground ring. The draft's "SSAO-lite" is not adopted (VL-026).
9. **Hybrid principle (1.0-rc2).** Space is 3D, signals are 2D, both from one token source (§1,
   VL-028).
10. **Application layout (1.1-rc, D9).** The 32 px top bar and the 40 px Time Ribbon on every page were
    sized for chrome floating over one full-screen canvas. Under the conventional layout of
    [ADR-0014](../adr/0014-typescript-react-web-client.md) §10 the sidebar and header are opaque and
    sized for legibility (VL-017, revised in place); translucency stays only for the Ribbon and
    minimap over Space scenes.

## 13. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft |
| 1.0-rc2 | 2026-11-18 | 3D-first estate per owner brief: §1 hybrid principle; definitions; VL-004 and VL-005 edited in place; motion table rows; new §10 3D scenes (VL-023 to VL-028); later sections renumbered §11–§13 |
| 1.1-rc | 2026-11-19 | Decisions D7–D9 (roadmap Q13): §7 layout tokens for the sidebar, page header, content padding and board panel gap; VL-017 revised in place (application layout dimensions); VL-019 adds the 16 px board panel gap; VL-021 generates CSS, TS and Rust token outputs; resolution 10 |
| 1.2-rc | 2026-11-20 | #57, owner-approved shell (2026-11-19): VL-017 adds the 56 px sidebar top block aligned with the header, title truncation before any header control moves, and the time trigger's absolute window from 1520 px |
