# T24 — Geo, schematic and widget panels

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-25 |
| **Milestone** | M-UI1 (sanitiser, links) → M-UI5 (widgets) |
| **Related ADRs** | [ADR-0007](../adr/0007-in-house-vis-engine.md), [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0024](../adr/0024-markdown-runtime-dependencies.md) |
| **Source draft** | plans/153 (not tracked) |

This document is the board **widgets**, the **geomap** and the **schematic**. It is written in parts
(§2): part A, here, defines the shared widget rules, the **Text / Markdown** widget with the one
Markdown renderer every vis and widget uses, and the **Clock / time zones** widget (rules T24-001 to
T24-018). Parts B–K add their rules in their own ID blocks.

## 1. Context & problem

[VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) asks for the Table 5-9
widgets on boards. Text renders Markdown with `{{entity}}` and Context variables, and Clock is a
multi-zone NOC clock with a countdown to a maintenance window.
[VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised)
asks that any Markdown or HTML a vis or widget renders is sanitised, and
[VIZ-056](../product/05-visualisation-catalogue.md#viz-056--no-arbitrary-iframes) that no iframe is
embedded: an imported iframe becomes a link that opens in a new tab, and the import report notes it.
[T18-013](T18-security.md#t18-013--markdown-renders-to-nodes-never-to-html-strings) needs a CommonMark
parser that yields a tree, and
[T08-011](T08-dom-component-kit.md#t08-011--markdown-cannot-produce-html) drops every HTML node.

The approach: widgets are DOM, with no query and no 3D form. Markdown is parsed by `commonmark` into a
tree and rendered to React elements per a `board` or `ai` policy, with URLs parsed and classified and
removals recorded without content. Import only appends links. Clock uses one due-time scheduler.

## 2. Goals / non-goals

Goals (part A): the T24 skeleton and its part map; the shared widget rules; the Text / Markdown widget
and its renderer, URL rule and removal log; the import conversion of iframes into links; the Clock
widget with zones, 12/24 h, a countdown and day and night cues without colour; board spec v4.

Non-goals (part A):
- parts B–K;
- opt-in basic HTML (T18-013);
- the image proxy (T18-014, A3 in §11);
- GFM tables and syntax highlighting;
- Text `renderMode: perRow` rendering;
- any 3D form.

**Part map.** Each part is designed under its own issue and adds its rules in its block.

| Part | Scope | Issue | Rules | Requirement ID if needed |
|---|---|---|---|---|
| A | Text / Markdown and Clock widgets, sanitiser and link rule (this revision) | #153 | T24-001–019 | VIZ-125 (reserved, unused) |
| B | Board list and Change feed widgets, and log panel gaps | #181 | T24-020–039 | VIZ-126 |
| C | Alert / incident list widget | #182 | T24-040–059 | VIZ-127 |
| D | Feed widget fetched by the BFF | #183 | T24-060–079 | VIZ-128 |
| E | Geomap 2D core: location sources, markers, offline basemap, camera and bounds filter | #184 | T24-080–099 | VIZ-129 |
| F | Geomap basemap pipeline and routes layer | #185 | T24-100–119 | VIZ-130 |
| G | Geomap M-UI5 layers: heatmap / hexbin, choropleth, network, day/night, track | #186 | T24-120–139 | VIZ-131 |
| H | Geomap true 3D: globe and extruded regions | #187 | T24-140–159 | VIZ-132–133 |
| I | Schematic model, viewer, data binding and audited actions | #188 | T24-160–179 | VIZ-134 |
| J | Schematic editor | #189 | T24-180–199 | — |
| K | Schematic import and auto-schematic | #190 | T24-200–219 | — |

Part A defines T24-001 to T24-018; T24-019 and VIZ-125 stay unused.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [VIZ-031](../product/05-visualisation-catalogue.md#viz-031--3d-only-when-it-encodes-a-dimension), [VIZ-086](../product/05-visualisation-catalogue.md#viz-086--true-3d-only) | §4.1 (T24-001, T24-003) | `unit:board-spec-widgets`; `golden:widget-gallery` |
| [VIZ-053](../product/05-visualisation-catalogue.md#viz-053--widgets-available) (Text and Clock rows) | §4.1 (T24-002, T24-008 to T24-012), §5.1 | `e2e:widget-text`; `e2e:widget-clock` |
| [VIZ-054](../product/05-visualisation-catalogue.md#viz-054--markdown-and-html-are-always-sanitised) | §4.1 (T24-004, T24-006, T24-007), §4.2 | `unit:markdown-nodes`; `fuzz:markdown-nodes`; `e2e:widget-text-xss` |
| [VIZ-056](../product/05-visualisation-catalogue.md#viz-056--no-arbitrary-iframes) | §4.1 (T24-005, T24-006, T24-016), §5.4 | `unit:markdown-iframe`; `unit:find-iframes`; `unit:import-text-iframe`; `fuzz:markdown-nodes`; `e2e:widget-text-xss` |
| [VIZ-057](../product/05-visualisation-catalogue.md#viz-057--field-configuration-parity) | §4.1 (T24-003), §5.1 | `unit:board-spec-widgets` |
| [VIZ-060](../product/05-visualisation-catalogue.md#viz-060--standard-panel-types-import-11) (Text and Clock rows) | §4.4 (T24-016), §5.4 | `unit:import-text-iframe`; `unit:import-size-error` |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §4.1 (T24-002: never auto-picked) | `e2e:widget-text` (no query) |
| [VIZ-066](../product/05-visualisation-catalogue.md#viz-066--table-view-and-csv-for-every-vis), [VIZ-068](../product/05-visualisation-catalogue.md#viz-068--screen-reader-summary-per-viewport) | §4.1 (T24-002, T24-009, T24-017) | `e2e:widget-a11y` |
| [VIZ-067](../product/05-visualisation-catalogue.md#viz-067--colour-is-never-the-only-channel), [VIZ-069](../product/05-visualisation-catalogue.md#viz-069--gallery-is-the-vis-test-corpus) | §4.1 (T24-013, T24-015), §10 | `golden:widget-gallery` |
| [VL-012](../product/08-visual-language.md#vl-012--numbers-for-humans) | §4.1 (T24-012) | `unit:clock-countdown`; `unit:countdown-due` |
| [VL-014](../product/08-visual-language.md#vl-014--purposeful-motion-only), [VL-016](../product/08-visual-language.md#vl-016--reduced-motion) | §4.1 (T24-015) | `e2e:widget-clock` |
| [T08-009](T08-dom-component-kit.md#t08-009--no-iframes), [T08-011](T08-dom-component-kit.md#t08-011--markdown-cannot-produce-html) (refined) | §4.1 (T24-004, T24-006) | `unit:markdown-nodes`; `unit:markdown-iframe` |
| [T18-011](T18-security.md#t18-011--url-scheme-allowlist) (refined) | §4.1 (T24-005, T24-008) | `unit:classify-url`; `unit:markdown-links`; `unit:markdown-interpolate` |
| [T18-013](T18-security.md#t18-013--markdown-renders-to-nodes-never-to-html-strings) (refined) | §4.1 (T24-004), §5.2 | `unit:markdown-nodes`; `fuzz:markdown-nodes` |
| [T18-014](T18-security.md#t18-014--external-images-only-through-a-signed-proxy) (amended: interim) | §4.1 (T24-018) | `unit:markdown-images` |

## 4. Design

### 4.1 Design rules

#### T24-001 — True 3D or honest 2D
**MUST** — (VIZ-086.) 3D is a real engine scene (depth, orbit/pan/dolly, occlusion,
[VL-023](../product/08-visual-language.md#vl-023--one-key-light-and-ambient) light), and its third axis
is a real dimension (VIZ-031). 2D never fakes depth (bevels, extrusions, shadows, isometric, tilts,
shading). Text and Clock are 2D.

#### T24-002 — Widgets are furniture
**MUST** — A widget has no query, `ChartFrame`, selection, `InspectorTarget`, `SummaryFacts`, table or
CSV. Its DOM text is the content. A widget is never auto-picked.

#### T24-003 — Widget spec
**MUST** — Widgets omit `query` (`board.panel.query.forbidden`), and data panels need it
(`board.panel.query.required`). Keys not in §5.1 (e.g. `depth`) → `board.json.unknownKey`.

#### T24-004 — One Markdown renderer
**MUST** — `renderMarkdown` (§5.2) walks the `commonmark` tree into §4.2 elements only, with no HTML
string sink. Table cells, feeds, tooltips and AI output reuse it.

#### T24-005 — URL classification
**MUST** — Link, image and import-iframe URLs pass `classifyUrl` after interpolation:
- a match of `URL_FORBIDDEN` → rejected;
- `/`-leading → `new URL(raw, appOrigin)`, `local` iff it is same-origin and its pathname is not `//…`;
- absolute → `http(s):` without credentials (`external`) or `mailto:` (links only);
- anything else is rejected.

A kept link renders as `<a target="_blank" rel="noopener noreferrer nofollow">` with a glyph and a
hidden "(opens in a new tab)". A rejected one renders as text and records `linkScheme`.

#### T24-006 — Iframes never render
**MUST** — Every HTML node is dropped (T08-011), with one removal per `html_block` and one per leaf
block's inline HTML (joined as in §5.4): `iframe` if `findIframes` finds one ("Embedded page not shown
(line n): add a link"), else `html`. Import (§5.4) turns iframes into links (VIZ-056).

#### T24-007 — Removal log carries no content
**MUST** — A `Removal` is `{kind, line}`, never text, URLs or values. The editor lists one i18n line per
removal; `logRemovals` does one `console.debug({panelId, removals})` per distinct result.

#### T24-008 — Interpolation on the tree
**MUST** — `$name`/`${name}` (`VARIABLE_REF`) and `{{entity}}` are replaced after parsing, in `text`
nodes and destinations only (destinations: `encodeURIComponent`, then T24-005). Code and `__` macros
stay literal. Unresolved references stay literal and log `unresolved`. `{{entity}}` is
`useContextEntity()` (`null` for now).

#### T24-009 — Structure
**MUST** — Heading n → `<h{min(n+3,6)}>`. The body is `role="region"` labelled by the title, with
`tabIndex=0` if it overflows.

#### T24-010 — Zones
**MUST** — A zone row shows the time, the label (else the IANA city), the date (if `date`), the UTC
offset and the day difference (§4.3). `tz: ''` is the Context zone. A zone the browser rejects shows
"Unknown time zone ‹tz›" in its row.

#### T24-011 — One scheduler
**MUST** — One `wallClock` (§5.3) sets one timeout at the earliest `due`, notifies those due, and
re-arms. While the page is hidden there is no timer; when it becomes visible it notifies all and
re-arms. It runs on wall time.

#### T24-012 — Countdown
**MUST** — `r = to − now`. The text floors `r`: `in ‹d› d ‹h› h` / `‹h› h ‹m› min` / `‹m› min` /
`‹s› s` for r ≥ 1 d / h / min / s, else `now`. For r ≤ 0: `countUp` shows `since HH:MM (‹elapsed›)`
(VL-012), or `hide` hides the row.

`countdownDue` is the first ms at which the text changes: `now + (r mod u) + 1`, with u = 1 h / 1 min /
1 s for r ≥ 1 d / 1 min / 1 s; `now + r` below 1 s; after `to`, with e = −r, `now + u − (e mod u)`,
with u = 1 s / 1 min.

A polite announcement is made when the text first reads 15, 5 or 1 min, or `since … (0 s)`, not on
first render, and once on resume after a crossing while hidden.

#### T24-013 — Day/night without colour
**MUST** — An hour in [06, 18) shows `sun` and "day", else `moon` and "night", with a neutral tint
only.

#### T24-014 — Widget states
**MUST** — An empty Text shows "This text panel is empty" (view) or "Write Markdown" (edit). Invalid
options never render.

#### T24-015 — Look
**MUST** — Inter 14/22 (Compact 13/20), code in JetBrains Mono; clock tabular figures at 32/24/18 px
(1 / 2–4 / more zones); a 4 px grid, 16 px padding and hairline rows. The only motion is a 150 ms
crossfade, cut under reduced motion.

#### T24-016 — Import
**MUST** — Import follows §4.4. `convertImportedText` (§5.4) only inserts: removing `inserted` gives
the input. Report entries carry at most a host.

#### T24-017 — Keyboard and SR
**MUST** — Tab reaches the region (if it overflows), then the links. A zone row is `role="group"`
labelled "‹label›, ‹time›, ‹date›, ‹day/night›, ‹offset›". The clock text is not live.

#### T24-018 — Render policy
**MUST** — `board`: a `local` image → `<img>`; an `external` one → a link (alt text or host; T18-014
interim); anything else → alt text. An image not rendered as `<img>` logs `image`. `ai`
([T18](T18-security.md) §4.10): no `<img>` or other auto-loading element; images → alt text and
`image`; links show their host.

### 4.2 Markdown node table (`commonmark` → output)

| Node | Output |
|---|---|
| paragraph | `<p>` |
| heading n | `<h{min(n+3,6)}>` |
| block_quote | `<blockquote>` |
| list | `<ul>` / `<ol start ≤ 999 999>` |
| item | `<li>` |
| thematic_break | `<hr>` |
| code_block | `<pre><code data-lang>` (info word `[a-z0-9-]{1,20}`) |
| text | text (interpolated, T24-008) |
| softbreak | `' '` |
| linebreak | `<br>` |
| emph, strong, code | `<em>`, `<strong>`, `<code>` |
| link | T24-005 |
| image | T24-018 |
| html_block, html_inline | T24-006 |
| anything else | dropped (`html`) |

No source attribute is copied. The output is pure and memoised.

### 4.3 Clock formats (`Intl.DateTimeFormat`)

The date is `weekday:'short', day:'numeric', month:'short'`; the offset is `longOffset`, with `GMT`
shown as `UTC`. The day difference is the zone date − the Context-zone date. `since` uses the first
zone.

### 4.4 Import mapping (#158, #17)

- **Text:** `mode` (`html` → `markdown`); `code.language`, or `plaintext` (noted);
  `convertImportedText(content, mode)`, with a report line per note; `ok: false` → §5.4 step 5.
- **Clock:** `timezone` → `zones[0].tz` (`''` if absent or "browser"; unknown → noted); `clockType`
  `12 hour` / `24 hour` / `custom` → `h12` / `h23` / `auto` (custom noted); countdown/countup with
  `countdownSettings.endCountdownTime` and `endText` → `countdown {to, label, after:'countUp'}`.
- Other keys are dropped ("Option ‹key› not mapped"); lines matching `^\s*\|.*\|\s*$` are noted
  "Markdown table shown as text".

## 5. Interfaces

### 5.1 Board spec v4 (OpenAPI, Go, TS)

`query` becomes optional; `Vis.kind` adds `text` and `clock`; `Vis.options` (#173) gains the keys
below (errors are `board.options.‹…›`):

| Key | Type / bounds | Default | Kinds | Error |
|---|---|---|---|---|
| mode | `markdown`\|`code` | `markdown` | text | `mode.invalid` |
| content | string ≤ 65 536 UTF-8 bytes | `''` | text | `content.tooLong` |
| language | `plaintext`\|`json`\|`yaml`\|`sql`\|`promql`\|`logql`\|`go`\|`shell` | `plaintext` | text, code mode only | `language.invalid` |
| zones | 1–12 × `{tz, label ≤ 64}`; `tz` `''` or loadable by Go `time.LoadLocation` (embedded tzdata), not `Local` | `[{tz:'',label:''}]` | clock | `zones.invalid`, `zones.duplicate` |
| hourCycle | `auto`\|`h12`\|`h23` | `auto` | clock | `hourCycle.invalid` |
| seconds, date | bool | `false`, `true` | clock | — |
| countdown | absent or `{to: RFC 3339 with offset, label 1–64, after: 'countUp'\|'hide'}` | absent | clock | `countdown.invalid` |

Go decides validity; the v3 → v4 upcaster is the identity
([T11-016](T11-postgres-schema.md#t11-016--document-upcasters-are-golden-tested)); the fixtures are
`v4-widgets.json` and `invalid.json`.

`isWidgetPanel(p)` narrows `PanelSpec` and guards every `panel.query` read; `textOptions` and
`clockOptions` fill the defaults; `PanelFrame` branches first to `<WidgetBody>`.

### 5.2 Renderer (`client/src/security/sanitise/`)

```ts
// url.ts
export type UrlClass = { kind: 'local'; href: string; host: string } | { kind: 'external'; href: string; host: string }
  | { kind: 'mailto'; href: string } | { kind: 'rejected' };
export const URL_FORBIDDEN = /[\u0000- \u007F-\u009F\\]/;
export function classifyUrl(raw: string, appOrigin: string): UrlClass;
// markdown.tsx
export type RenderPolicy = 'board' | 'ai';
export type RemovalKind = 'html' | 'iframe' | 'linkScheme' | 'image' | 'unresolved';
export interface Removal { readonly kind: RemovalKind; readonly line: number } // block start line
export function renderMarkdown(src: string, env: { vars: ReadonlyMap<string, string>; entity: string | null },
  opts: { policy: RenderPolicy; appOrigin: string; headingOffset?: number /* 3 */ }): { node: ReactNode; removals: readonly Removal[] };
export function renderCode(src: string, language: CodeLanguage): ReactNode;
export function findIframes(html: string): readonly { line: number; src: string | null }[];
export function logRemovals(panelId: string, removals: readonly Removal[]): void;
```

Both options are required.

**`findIframes`** returns the **union**, de-duplicated by start offset and sorted, of (a) the `iframe`
elements in the `parse5.parse` tree (template content included) and (b) the `iframe` start-tag tokens
from `parse5-sax-parser`; both with `sourceCodeLocationInfo`, spec attribute decoding and the first
duplicate `src` (or `null`).

**Rule:** a destination is recovered if either the spec tree or the spec tokenizer sees an iframe start
tag. Each covers the other's gap (tree: `<select><iframe>`; SAX: `<select><title><select><iframe>`);
both keep the raw-text, RCDATA, comment and CDATA protection; over-counting only adds a link.

Dependencies ([ADR-0024](../adr/0024-markdown-runtime-dependencies.md)): `dependency-policy.json`
`runtimeAllowlist` += `commonmark`, `parse5`, `parse5-sax-parser`; `runtimeClosure.markdown` = those
plus `entities`, `mdurl`, `minimist`; pins `commonmark` 0.31.2, `parse5` 8.1.1 (moves from
devDependencies), `parse5-sax-parser` 8.0.1; `@types/commonmark` as a dev dependency.

### 5.3 Wall clock (`client/src/state/wallClock.ts`)

```ts
export interface WallClock { now(): number; subscribe(cb: () => void, due: (now: number) => number): () => void }
export function createWallClock(nowFn?: () => number, timers?: Timers, doc?: Pick<Document, 'hidden' | 'addEventListener'>): WallClock;
export const boundaryDue = (unitMs: number) => (now: number) => now - (now % unitMs) + unitMs;
export function countdownDue(toMs: number): (now: number) => number;
export function useWallClock(due: (now: number) => number): number;
```

### 5.4 Import conversion (`sanitise/importText.ts`, called by #158 and #17)

```ts
export type ImportNote = { kind: 'iframeToLink'; line: number; host: string } | { kind: 'iframeNoLink'; line: number }
  | { kind: 'htmlNotRendered'; count: number };
export function convertImportedText(content: string, mode: 'markdown' | 'code', appOrigin: string):
  | { ok: true; content: string; notes: readonly ImportNote[]; inserted: readonly { offset: number; text: string }[] }
  | { ok: false; reason: 'sizeLimit'; links: number };
export interface TextImportError { kind: 'textTooLargeForLinks'; panelIndex: number; sourceId?: number; links: number }
export function markdownLink(label: string, href: string): string; // [esc(label)](<href: & → &amp;, < > \ escaped>)
```

The conversion is **append-only** (VIZ-056 needs a link and a report). `mode: 'code'` → unchanged, with
no notes. Otherwise one parse:

1. `findIframes` runs on each `html_block` literal (line = block start + `line` − 1) and once per leaf
   block on its `html_inline` literals joined in order, so `<script>` + `'<iframe …>'` + `</script>`
   stays raw text (line = leaf start).
2. Each iframe with a `local` or `external` `src` gives `markdownLink('Open embedded page (‹host›)',
   href)` and `iframeToLink {line, host}`; otherwise `iframeNoLink {line}`. The notes are sorted by
   line, then `htmlNotRendered {count}`.
3. A top-level block's links (space-joined) are inserted at E, just after its last line's newline:
   `"\n" + links + "\n"`, plus `"\n"` before a non-blank next line, with a leading `"\n"` at EOF
   without a newline. The iframe HTML stays (it is dropped at render).
4. `markdownLink` escapes label punctuation; `<dest>` has `&` → `&amp;` and `<`, `>`, `\` escaped.
5. **Size:** if the result exceeds 65 536 UTF-8 bytes it returns `{ok: false, reason: 'sizeLimit',
   links: n}`. The importer omits that panel, imports the rest, and adds a `TextImportError`
   (`sourceId` if an integer): "Text panel #‹index› (id ‹id›) is too large to add embedded-page links
   (‹n› links). Shorten or split it in the source and import again." No content is copied; the source
   file is the copy.

## 6. Data & storage

Board spec v4 (§5.1) is stored as the board document is today; the v3 → v4 upcaster is the identity
(T11-016). There is no new table, route or storage: widgets fetch nothing and make only safe GETs
(links and `local` images).

## 7. Performance budget

The Markdown and parse5 code loads as lazy chunks within the ADR-0014 §8 budgets (ADR-0024).
Report-only: `bench:markdown-render` (64 KiB ≤ 16 ms p95) and `bench:clock-tick` (20 Clocks × 12 zones
≤ 2 ms per tick).

## 8. Security, tenancy & RBAC

- One renderer with no HTML string sink (T24-004, [T18-005](T18-security.md#t18-005--one-trusted-types-sink),
  T18-013); every URL is classified after interpolation (T24-005, T18-011).
- Removals and import errors carry no content (T24-007, §5.4 step 5).
- AI output loads no image or other auto-loading element (T24-018, T18 §4.10). Until the image proxy
  ships, no external image is loaded (T18-014 interim).
- Tenancy: widgets fetch and store nothing; RLS is unchanged.

## 9. Failure modes & degradation

| Risk | Handling |
|---|---|
| URL bypass, log or report leaks, AI images | `classifyUrl` and the fuzz gate; content-free removals and errors; `ai` has no `<img>` |
| Tenancy; spec versions | No fetch or storage; safe GETs; the next spec version |
| Ticks; zones | The due-time scheduler (T24-011); Go decides zone validity; a bad zone → one row (T24-010) |

## 10. Testing

Written first in the implementation issues. Origin `https://dash.test`; all fail today.

| Test | File | Setup | Expected | Covers |
|---|---|---|---|---|
| `unit:board-spec-widgets` | spec.test.ts, validate_test.go | fixtures | valid → none; text + `query` → `board.panel.query.forbidden`; line without → `.required`; clock `depth` → `unknownKey`; 13 zones, `tz:'Mars/Base'` → `zones.invalid`; duplicate zone → `.duplicate`; 65 537 bytes → `content.tooLong`; `to:'2026-11-26 14:00'` → `countdown.invalid`; TS = Go; v3 upcasts | T24-003, VIZ-031, 057 |
| `unit:classify-url` | sanitise/url.test.ts | strings | rejected: `/\t/evil.test`, `/a/../..//evil.test`, `/.//evil`, `/\\evil.test`, `//evil.test`, ` /x`, `/x\u0085`, `https://u:p@x.test/`, `JaVaScRiPt:x`, `data:,x`, `boards/b1`; local: `/boards/b1?x=1#h`, `/%5Cevil.test` (unchanged); external: `HTTPS://X.TEST` → `https://x.test/`; mailto: `mailto:o@x.test` | T24-005 |
| `unit:markdown-links` | sanitise/markdown.test.tsx | inputs L (below) | a → text + `linkScheme`; t → `/%09/e.test`; b, d, e → new-tab `<a>` | T24-005 |
| `unit:markdown-nodes` | same | `"<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n**ok**"`; `# A\n###### F\n1000000. x` | DOM `<p><strong>ok</strong></p>`, removals `[{html,1},{html,3}]`; `<h4>`, `<h6>`, `<ol start="999999">` | VIZ-054, T24-009 |
| `unit:markdown-iframe` | same | `<iframe src="https://s.test/"></iframe>`; `<div>t<iframe src="/b"></iframe></div>`; `a <script>'<iframe src="/b">'</script>` | nothing rendered; removals `[iframe]`, `[iframe]`, `[html]` | T24-006 |
| `unit:markdown-images` | same | inputs I (below); `board`, then `ai` | board: `<img src="/l.svg">`, link "g", text "d", `<img src="/%09/e.test">`; ai: 4 texts + `image`, no `img` | T24-018, T18-014 |
| `unit:markdown-interpolate` | same | inputs V (below) | text `Env prod prod $missing $__from {{entity}}`; code `$env`; href `?q=a%20b%26c`; y → text + `linkScheme` | T24-008 |
| `unit:removal-redaction` | same | `[x](javascript:fetch('https://u:hunter2@e.test/?token=abc'))`; `<a href="https://e.test/?token=abc">` | `[{linkScheme,1}]`, `[{html,1}]`; editor text and `console.debug` JSON lack `hunter2`, `token`, `e.test` | T24-007 |
| `fuzz:markdown-nodes` | sanitise/markdown.fuzz.test.ts | 10 000 inputs (seed 20261125), both policies, import | tags ⊆ §4.2; attributes ⊆ `href target rel src alt loading start data-lang`; URLs re-classify; `ai` no `img`; import inverse | VIZ-054, 056 |
| `unit:find-iframes` | sanitise/findIframes.test.ts | `<iframe data-src="a" src="b">`, `<iframe title='src="x"'>`, `<iframe src="b" SRC="c">`, `<iframe src="?a&copy=1">`, `<!-- x --!><iframe src=y>`, `<!--><iframe src=z>`, `<select>`/`<table>`/`<frameset>`/`<template>`/`<svg>`/`<select><title><select>` + `<iframe src=w>`; then `<script>`, `<textarea>`, `<title>`, `<style>`, `<xmp>`, `<plaintext>`, `<![CDATA[`, `<?x`, `</ ` before `<iframe src=x>` | `b`, `null`, `b`, `?a&copy=1`, `y`, `z`, `w` ×6; none for the rest or `<svg><![CDATA[…]]>`; no duplicates | T24-006 |
| `unit:import-text-iframe` | sanitise/importText.test.ts | f1, f3–f10 | exact `inserted`, `notes`; removing `inserted` gives the input byte-for-byte; hrefs f1 `https://x.test/a)b?q=%5B1%5D&r=%3C2%3E`, f3 `https://x.test/?a=&copy;&b=&#169;&c=&amp;d&e=1`, f5 as listed; f4/f6–f10 as listed | VIZ-056, T24-016 |
| `unit:import-size-error` | same | 65 500-byte panel "Payroll", `src` with `?token=SECRET123` | error `{kind:'textTooLargeForLinks', panelIndex, sourceId, links:1}`; JSON and message lack `SECRET123`, `Payroll` | T24-016 |
| `unit:clock-format` | widgets/clock/format.test.ts | 12:34:56Z, Context London, en-GB | Tokyo `21:34` `Thu 26 Nov` `UTC+09:00` night; New York `07:34` `UTC−05:00` day; Auckland `01:34` `Fri 27 Nov` `+1 day` night; UTC `12:34` `UTC` day; `h12` Tokyo `9:34 pm` | T24-010, 013 |
| `unit:clock-countdown` | same | `to` 14:49:56Z, 12:35:38Z, 12:34:56Z, 12:22:56Z, +2 d 3 h | `in 2 h 15 min`, `in 42 s`, `since 21:34 (0 s)`, `since 21:22 (12 min)`, `in 2 d 3 h`; `hide` + past → no row | T24-012 |
| `unit:countdown-due` | state/wallClock.test.ts | `to` fixed; r in ms | r → (text, due, next): 125 000 (`2 min`, +5 001, `1 min`); 120 000 (`2 min`, +1, `1 min`, announced); 960 000 (`16 min`, +1, `15 min`, announced); 60 000 (`1 min`, +1, `59 s`); 1 000 (`1 s`, +1, `now`); 1 (+1, `since … (0 s)`, announced); after-`to` e 59 999 (+1 → `1 min`). Property (200 s → −130 s, 137 ms steps): text changes exactly at due | T24-011, 012 |
| `unit:wall-clock` | same | fake timers; zone + countdown | one timer at earliest due; hidden at r = 90 s → none; visible at 30 s → all notified, `in 30 s` announced once; last unsubscribe clears | T24-011 |
| `e2e:widget-text` | e2e/widgets.spec.ts | `"# R\n[S](https://s.test)\nEnv $env"`, env=prod | `h4`; `_blank` link; env=dev → "Env dev", no query | VIZ-053 |
| `e2e:widget-text-xss` | same | `unit:markdown-nodes` input + iframe line; payloads set `window.__xss` | `__xss` unset; no CSP violation or page error; no `iframe`; removals `[html, html, iframe]` | VIZ-054, 056 |
| `e2e:widget-clock` | same | `page.clock` 12:34:56Z; Tokyo, NY; countdown to 12:35:56Z; reduced motion too | `in 1 min`, silent; +1 s `in 59 s`; +59 s `since 21:35 (0 s)`, announced; no transition if reduced | T24-012, VL-016 |
| `e2e:widget-a11y` | same | both, view/edit | axe clean; T24-017 order; "Tokyo, 21:34, Thu 26 Nov, night, UTC+09:00" | T24-017, VIZ-066, 068 |
| `golden:widget-gallery` | e2e/widget-gallery.spec.ts | 5 pages × dark/light/grey, fixed clock | CI baseline (0.1, ≤ 0.2 %) | VIZ-069, 067 |

Markdown inputs for the rows above (one per line, as written in the test):

```text
L  [a](javascript:x)   [t](</\t/e.test>)   [b](https://x.test/p)   [d](/b)   [e](mailto:o@x.test)
I  ![l](/l.svg)   ![g](https://x.test/g.png)   ![d](data:,x)   ![s](</\t/e.test>)
V  vars {env:'prod', q:'a b&c', u:'javascript:x'}; Env $env ${env} $missing $__from {{entity}}   `$env`
   [x](https://x.test/?q=$q)   [y]($u)
```

`ci:dep-audit` and `ci:no-iframe` still pass. Report-only: `bench:markdown-render` (64 KiB ≤ 16 ms
p95), `bench:clock-tick` (20 Clocks × 12 zones ≤ 2 ms per tick). No itest until A3. Every gate is in
[T05 §7.1](T05-testing-and-performance.md#71-gate-catalogue).

Fixtures `api/fixtures/import/text-iframe.json` (all pass in a prototype; ⏎ is a newline, a leading
number is a line number):

```text
f1 1 Intro <iframe src="https://x.test/a)b?q=[1]&amp;r=<2>"></iframe> end⏎2 <div>⏎3 keep <b>me</b>⏎4 <iframe src="https://intended.test/"></iframe>
   5 </div>⏎6 after⏎7⏎8 `<iframe src="https://code.test/">` and \<iframe src="https://esc.test/">⏎9⏎10 <iframe src="javascript:alert(1)"></iframe>
   after 1: ⏎[Open embedded page \(x\.test\)](<https://x.test/a)b?q=[1]&amp;r=%3C2%3E>)⏎⏎; after 6: ⏎[…](<https://intended.test/>)⏎
   notes [{iframeToLink,1,x.test},{iframeToLink,4,intended.test},{iframeNoLink,10},{htmlNotRendered,4}]
f3 <iframe src="https://x.test/?a=&amp;copy;&amp;b=&amp;#169;&amp;c=&amp;amp;d&amp;e=1"></iframe>
   insert ⏎[Open embedded page \(x\.test\)](<https://x.test/?a=&amp;copy;&amp;b=&amp;#169;&amp;c=&amp;amp;d&amp;e=1>)⏎
f4 1  0  `<iframe src="https://code.test/">`⏎3 <script>const e = '<iframe src="https://s1.test/">';</script>
   5 <style>/* <iframe src="https://s2.test/"> */</style>
   7 x <textarea><iframe src="https://s3.test/"></textarea> <title><iframe src="https://s4.test/"></title> y
   9 <iframe src="https://real.test/"><iframe src="https://inner.test/"></iframe>⏎11     <iframe src="https://indented.test/">⏎13 <plaintext><iframe src="https://p.test/">
   insert after 9 only (real.test); notes [{iframeToLink,9,real.test},{htmlNotRendered,11}]
f5 <iframe src="https://x.test/?a=1&copy=2&b=&copy;&c=&notit;&d=&#169=x"></iframe>
   href https://x.test/?a=1&copy=2&b=%C2%A9&c=&notit;&d=%C2%A9=x (= browser's src URL)
f6 B = `<iframe src="https://s.test/"></iframe>⏎` + 65 442 × `x` + `⏎` (65 483 bytes; insert is 53) → 65 536 bytes, converted;
   one more `x` → `{ok:false, sizeLimit, links:1}`; B with mode code → `ok`, unchanged, notes []
f8 <div><!-- a --!><iframe src="https://bang.test/"></iframe></div>⏎⏎x <!-- b --!> <iframe src="https://bang2.test/"></iframe> y
   inserts after 1 and 3; notes [{iframeToLink,1,bang.test},{iframeToLink,3,bang2.test},{htmlNotRendered,3}]
f9 lines 1, 3, 5, 7: <select><iframe src="https://sel.test/"></iframe></select> · a <select><iframe src="https://sel2.test/"></select> b ·
   <frameset><iframe src="https://fs.test/"></frameset> · <template><iframe src="https://tpl.test/"></template> → a link after each; 4 iframeToLink, {htmlNotRendered,11}
f10 <select><title><select><iframe src="https://x.test/"></iframe></select></title></select>⏎⏎a ‹same with y.test› b
   links after 1, 3; notes [{iframeToLink,1,x.test},{iframeToLink,3,y.test},{htmlNotRendered,16}]
f7 lines 1–13 (blank between): <![CDATA[<iframe src="https://c1.test/">]]> · a <![CDATA[<iframe src="https://c2.test/">]]> b ·
   <?x <iframe src="https://p1.test/"> ?> · a <?x <iframe src="https://p2.test/"> ?> b · <!DOCTYPE <iframe src="https://d.test/">> ·
   <div></ <iframe src="https://b.test/">x</div> · <div><!--><iframe src="https://after.test/"></div>
   only insert: after 13, after.test; notes [{iframeToLink,13,after.test},{htmlNotRendered,7}]
```

## 11. Rollout

Implementation issues, filed after this design merges:

| Issue | Scope | Depends on | Covers |
|---|---|---|---|
| A1 — Text, renderer, spec v4 | §5.1, §5.2, §5.4, editor, gallery `widget-text`, `widget-text-removals` | #173 | T24-001–009, T24-014–018 |
| A2 — Clock | §5.3, editor, gallery `widget-clock-1`, `widget-clock-4`, `widget-clock-countdown` | A1 | T24-010–015, T24-017 |
| A3 — Image proxy | T18-014 route, rewrite | T18 §4.9 egress guard | T18-014 |

A1 needs #173 (board spec v3) and ships v4 (or the next free version). The implementation writes
`docs/client/widgets.md` (behaviour, Markdown, URLs, import, Clock) and updates
`docs/client/boards.md`, `docs/user/boards.md`, `docs/server/boards-api.md` and
`docs/client/supply-chain.md` (widget panels, the v4 keys, the `markdown` dependencies).

## 12. Alternatives considered

Rejected:
- a separate sanitiser ([T08](T08-dom-component-kit.md) §12);
- hand-written HTML scanning;
- one parser mode (the tree or the tokenizer alone each misses a context, §5.2);
- `DOMParser` (a Trusted Types sink, T18-005).

## 13. Open questions

None.

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-25 | #153 part A: created: the part map and ID blocks for parts A–K; rules T24-001 to T24-018; the Markdown node table, clock formats and import mapping; board spec v4, the renderer, wall clock and import conversion interfaces; tests and fixtures; the implementation issues A1–A3; [ADR-0024](../adr/0024-markdown-runtime-dependencies.md) |
