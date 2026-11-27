# Visual design: tokens, materials and the kit's look

The visual refresh of #282 (Part 1: tokens, shell and kit). The direction is **"a calm instrument in
a finished case"**: graphite neutrals, one blue accent, depth from light (lifted surfaces, a 1 px
top highlight and soft shadows) instead of boxes and dashed borders, translucency only where
content passes beneath, capsule buttons and a segmented control, menus that highlight the row in
the accent, and the platform UI face on Apple systems. Data colours, marks, layout sizes and the
information architecture do not change.

It implements [VL-001, VL-004, VL-010, VL-011, VL-014, VL-016, VL-017 and
VL-019](../../designs/product/08-visual-language.md) as amended by #282, the kit rules of
[T08](../../designs/technical/T08-dom-component-kit.md) (T08-007, T08-019, T08-022) and
[ADR-0035](../../designs/adr/0035-platform-ui-face.md) (the platform UI face). Part 2 (board
chrome, tables, Explore and the log stream) restyles those surfaces on these tokens only.

## Tokens

Every value lives in `design/tokens.toml`; `npm run tokens` generates `src/styles/tokens.css`,
`src/styles/tokens.ts` and the engine's `dash-tokens/src/tokens.rs` ([Client: tokens and
token-lint](README.md#tokens-and-token-lint)).

### Colours (chrome)

| Token | Dark | Light | Use |
|---|---|---|---|
| `canvas` | `#0E1014` | `#F2F3F6` | the page |
| `surface-1` | `#15171C` | `#FFFFFF` | cards, the header and every material's opaque fallback |
| `surface-2` | `#1D2026` | `#EEF0F3` | empty states, inner wells |
| `surface-hover` | `#262A31` | `#E5E8ED` | row and ghost hover |
| `sidebar` | `#121418` | `#EBEDF1` | the source list (opaque, never a material) |
| `control`, `control-hover`, `control-pressed` | `#23272E`, `#2A2F37`, `#31363F` | `#FFFFFF`, `#F6F7F9`, `#ECEEF1` | default buttons |
| `field` | `#111317` | `#FCFCFD` | text fields, select triggers, the checkbox box, the segmented track, the header capsules |
| `border-control` | `#FFFFFF29` | `#1C22333D` | control, popover, dialog and capsule edges |
| `border-field` | `#6A717C` | `#7D8490` | field boundaries: at least 3:1 from the fill and every surface beneath (VL-009) |
| `hairline` | `#FFFFFF14` | `#1C223314` | separators, card edges |
| `highlight` | `#FFFFFF0F` | `#FFFFFF99` | the elevation tokens' 1 px top highlight |
| `shadow-ambient`, `shadow-key` | `#00000066`, `#0000008C` | `#141A2414`, `#141A2426` | the elevation tokens' shadows (hue-free) |
| `text`, `text-muted` | `#E9EBEF`, `#9AA1AC` | `#1B1E25`, `#565E6B` | text |
| `accent`, `focus` | `#4D9BFF` | `#185FCC` | links, row icons, the focus ring |
| `accent-fill`, `accent-pressed` | `#2B68D6`, `#255CC0` | `#185FCC`, `#1552B3` | primary buttons, the current sidebar row, the segmented thumb, the focused menu row, the avatar, the skip link |
| `text-on-accent` | `#F5F8FF` | `#FFFFFF` | text and icons on `accent-fill` (never on `accent`) |
| `backdrop` | `#05060899` | `#1B1E2540` | the modal overlay (no blur) |
| `material-bar` | `#15171CE6` | `#FFFFFFD9` | the header's material |
| `material-menu` | `#1E2127EB` | `#FAFBFCE6` | popovers, menus, listboxes, tooltips, the Inspector |
| `surface-float` | `#15171CF0` | `#FFFFFFF0` | the geomap overlay only |

Every key differs between the themes, and the light values are designed, not inverted. Series,
level, state, ramp, syntax, map, `brush`, `selection` and `pattern-ink` are unchanged.
`unit:ui-token-contrast` (`src/styles/uiTokens.test.ts`) checks the chrome pairs in both themes,
compositing translucent colours over what lies beneath: field boundaries ≥ 3:1, text ≥ 4.5:1 on the
surfaces, controls, fields and both materials (over `canvas`, `surface-1`, white and black),
`accent` ≥ 4.5:1 and `focus` ≥ 3:1 on the surfaces, `text-on-accent` ≥ 4.5:1 on `accent-fill` and
`accent-pressed`, and `accent-fill` ≥ 3:1 against the sidebar, the segmented track and the menu
material. State colours as text on `surface-1` and `surface-2` keep 4.5:1 where they
had it before #282 and never fall more than 0.15 below their earlier ratio; the strict 4.5:1 for
every state pair needs new state colours and is tracked in #284.

### Scales

| Scale | Values |
|---|---|
| `space` | adds `0-5` = 2 px (insets inside a control) to 4, 8, 12, 16, 20, 24, 32, 40, 48, 64 |
| `size` | `control` 28 px (was 32; `target-min` stays 24), `focus-ring` 3 px, `focus-offset` 1 px |
| `radius` | `xs` 4 (menu items, the checkbox), `default` 6 (fields, tooltips), `md` 10 (cards, popovers, menus, the Inspector, the geomap overlay), `lg` 14 (dialogs), `pill` 9999 (buttons, the segmented control, the header capsules). `radius.float` is gone |
| `font.family` | adds `ui-apple`: `-apple-system, BlinkMacSystemFont, "Inter Variable", system-ui, sans-serif` |
| `font.weight` | adds `bold` 700 |
| `font.tracking` | `lg` −0.011 em, `xl` −0.017 em, `display` −0.022 em (`--tracking-*`); Inter only, 0 on Apple systems |
| `elevation` | `1`, `2`, `3` (`--elevation-*`): a 1 px top highlight, an ambient and (2, 3) a key shadow |
| `material` | `filter`: `blur(24px) saturate(180%)` (`--material-filter`) |
| `motion` | adds `quick` 100 ms and `easing-in` `cubic-bezier(0.4, 0, 1, 1)`; reduced motion sets every duration to 0 ms |

The generator accepts strings in `font.family`, `elevation`, `material` and `motion` only without
`;`, `{`, `}`, `<`, `>` or `\`, and a tracking value only within ±0.05 em; otherwise it exits 2
naming the key. In Rust, `font::tracking::LG` is an `f32`, `elevation::E_1` and
`material::FILTER` are `&str`, and `space."0-5"` is `space::S_0_5`.

## Elevation and materials

| Surface | Elevation | Material | Radius |
|---|---|---|---|
| Default and primary buttons, the segmented thumb, cards | `elevation-1` | — | `pill`, `pill`, `md` |
| Popovers, menus, listboxes, tooltips, the Inspector | `elevation-2` | `material-menu` | `md` (tooltips `default`) |
| Modal dialogs | `elevation-3` | — (`surface-1`; the overlay is `backdrop`, unblurred) | `lg` |
| The header | — | `material-bar` | — |
| The sidebar | — | none: opaque `sidebar` | — |

A material is opaque `surface-1` by default. Only inside
`@supports (backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))` and
`@media (prefers-reduced-transparency: no-preference) and (not (forced-colors: active))` does it
take the translucent colour and `var(--material-filter)`. The prefixed declaration comes first:
the minifier keeps the last of the pair and adds the other where its targets need it.
`unit:material-fallback` (`scripts/material-fallback.test.ts`) checks the header, popover, tooltip
and Inspector modules for this shape.

**Fallbacks.** Without `backdrop-filter`, under reduced transparency, or under forced colours, every
material is opaque `surface-1` in both themes. Forced colours also drop the shadows; borders and
focus rings remain. The accent-filled states (the current sidebar row, the segmented thumb, the
focused menu and listbox row, the selected time preset, the checked box) use
`forced-color-adjust: none` with `Highlight` and `HighlightText`.

## The kit and the shell

| Component | Rest | States |
|---|---|---|
| Button | `control`, 1 px `border-control`, `pill`, 28 px high, 13 px medium, `elevation-1` | hover `control-hover`, pressed `control-pressed` over `motion.quick`; disabled muted, no shadow |
| Button primary | `accent-fill`, no border, `text-on-accent` | pressed `accent-pressed` |
| Button ghost, IconButton | transparent, no border or shadow; IconButton 28 × 28, `pill` | hover `surface-hover`, pressed `control-pressed` |
| SegmentedControl | `field` track, 1 px `border-control`, `pill`, 28 px | the selected item is an `accent-fill` thumb (`pill`, `elevation-1`, `text-on-accent`) 2 px in from the track's outer edge; items at least 24 px |
| TextField, Select trigger, TextArea | `field`, 1 px `border-field`, radius `default`, 28 px (TextArea: at least 28, its `rows` tall, vertical resize) | focus: the global ring at offset 0; invalid: dashed `text` border |
| Checkbox | 16 px box, `xs`, `field`, 1 px `border-field`; the label row at least 24 px | checked `accent-fill` with a `text-on-accent` tick; the ring on the box |
| Menu, Select listbox | padding 4 px, rows 28 px, `xs`, 13 px regular; hairline separators inset 8 px | the focused row `accent-fill` with `text-on-accent` (the check too), no outline |
| Tooltip | `material-menu`, `default`, `elevation-2`, 12 px | — |
| Modal dialog | `surface-1`, 1 px `border-control`, `lg`, `elevation-3`; title 16 px semibold, `tracking-lg` | — |
| Card | `surface-1`, 1 px `hairline`, `md`, `elevation-1`; title 13 px semibold | — |
| EmptyState | `surface-2`, no border, `md`; title 13 px semibold, body muted | — |
| Sidebar | `sidebar`, a right hairline; rows 28 px, `default`, 8 px inset, no gap; icons `accent`, labels `text` 13 px | hover `surface-hover`; the current row (expanded and collapsed) `accent-fill`, its icon and label `text-on-accent`, semibold, no inset bar |
| Header | `material-bar`, a bottom hairline; title 16 px semibold, `tracking-lg`; breadcrumb 13 px muted | the time-range trigger and the refresh control are 28 px `field` capsules with a `border-control` edge |
| User menu avatar, skip link, selected time preset | `accent-fill`, `text-on-accent` | — |

**Focus.** `:focus-visible` and the kit's `data-focus-visible` draw a `size.focus-ring` (3 px)
solid `focus` outline at `size.focus-offset` (1 px), following `border-radius`; fields use offset
0, and inset rings in rows keep `calc(var(--size-focus-ring) * -1)`.

**Motion** (inside `@media (prefers-reduced-motion: no-preference)`, keyframes local to each
module, on React Aria's `data-entering` and `data-exiting`):

| Surface | Enter | Exit |
|---|---|---|
| Popover, menu, listbox | `motion.fast` (150 ms): opacity and `scale(0.98)` to 1 from `--trigger-anchor-point`, `easing-out` | `motion.quick` (100 ms) opacity, `easing-in` |
| Tooltip | 100 ms opacity | 100 ms opacity |
| Modal | `motion.float-open` (200 ms): opacity and an 8 px rise, `easing-out`; the overlay fades over 200 ms | `motion.fast` (150 ms) opacity |
| Controls | colour and background over `motion.quick` | — |

Under reduced motion there is no animation, so React Aria mounts and unmounts a popover or dialog
on the same frame (VL-016). Nothing bounces (VL-014).

## The platform UI face (ADR-0035)

`src/theme/platform.ts` runs in `main.tsx` before the first render:
`applyPlatform(document.documentElement, navigator)` sets `html[data-platform="apple"]` when
`navigator.userAgentData.platform` (or, without it, `navigator.platform`) starts with `mac`,
`iphone`, `ipad` or `ipod` (iPadOS reports `MacIntel`), and removes it otherwise. A throw is caught
and logged; the page keeps Inter. Under `data-platform="apple"`, `global.css` sets
`--font-ui: var(--font-ui-apple)` and zeroes `--tracking-lg`, `--tracking-xl` and
`--tracking-display` (the system face tracks itself).

Canvas text keeps `font.family.ui` (Inter) and `font.family.mono` on every platform
(`engine/canvas2d/layout.ts`), so chart text and the future glyph atlas stay Inter and JetBrains
Mono (VL-011). On Apple systems the DOM never asks for Inter, but the Canvas 2D engine still loads
it on chart init (`document.fonts.load(STAT_FONT)`) and redraws once it arrives; JetBrains Mono
loads for data. Every font stays same-origin (ADR-0016). `e2e:font-origin` covers the Apple leg
with a faked `navigator.platform`.

## The `shadow-token` lint (VL-004)

`npm run token-lint` checks every `box-shadow` outside the generated files: the value is split on
top-level commas, and a shadow is a drop shadow when it has no `inset` keyword and its third
component is not the literal `0`. A drop shadow is allowed only as the whole value
`var(--elevation-1|2|3)`, or `none`. Inset bars (`inset 2px 0 0 var(--accent)`) and spread-only
rings (`0 0 0 var(--size-focus-ring) var(--selection)`) pass. A finding reads `drop shadows come
only from the elevation tokens (VL-004)`. Visualisations never have shadows.

## Adding or changing a token

1. Edit `design/tokens.toml`, in both themes for a colour (designed, not inverted).
2. Run `npm run tokens` and commit the three generated files.
3. For a chrome colour pair, add it to `unit:ui-token-contrast`; for a new material, use the
   opaque-by-default shape above and add the module to `unit:material-fallback`.
4. Run `make client-check`. A token that reaches the engine (every colour does) moves the engine
   goldens and the parity fixtures: regenerate them in the pinned containers (`make
   engine-goldens-update`, `npm run engine-fixtures -- --write`, the client goldens with
   `PW_UPDATE_GOLDENS=1`; [build and CI](../development/build-and-ci.md)).

## Reviewing a visual change

A visual change is shown to the owner before merge as before and after screenshots, kept out of the
repository: Chromium at 1440 × 900 on the stub build with the suite's fixed time, of the boards
list, board b-1 (view and Edit), Explore Metrics and Logs with a result, the New board dialog and
the user menu open, each in dark and light (14 per set), once from the base build and once from the
branch build. Only the committed goldens hold images.

## Tests

`unit:tokens-gen`, `unit:ui-token-contrast`, `unit:shadow-token`, `unit:material-fallback`,
`ci:token-lint`, `unit:platform-face`, `e2e:font-origin` (Apple legs), `e2e:theme`,
`e2e:kit-materials`, `e2e:kit-shapes`, `e2e:kit-focus`, `e2e:kit-motion` (`e2e/kit-chrome.spec.ts`),
and the client and engine goldens.
