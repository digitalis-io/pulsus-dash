# T09 — Query editors: PromQL, LogQL, TraceQL

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.0-rc · 2026-11-18 |
| **Milestone** | M-UI1 (PromQL editor, completion, explain, visual builder, auto-vis hint) → M-UI2 (LogQL, TraceQL, profile selectors, ⌘K detection for all four, history) → M-UI4 (alert-rule editor, AI explain/generate, virtual-source diagnostics) → M-UI5 (Board variables UI, LogQL/TraceQL builders) |
| **Related ADRs** | [ADR-0001](../adr/0001-rust-wasm-everywhere.md), [ADR-0002](../adr/0002-no-js-ui-framework.md), [ADR-0004](../adr/0004-leptos-dom-rooms.md), [ADR-0012](../adr/0012-derived-state-in-postgres.md) |
| **Source draft** | plans/tech/T09-query-editors.md (not tracked) |

## 1. Context & problem

Most users never type a query ([13](../product/13-core-flow-storyboard.md): "zero queries typed").
The ones who do are experts, and they compare us with the query explorers of incumbent tools, which run full JS code
editors with language servers. With no JS editor available
([ADR-0002](../adr/0002-no-js-ui-framework.md)), we need a Rust editor that is as good for queries of
a few hundred bytes up to 128 KB.

That means:
- highlighting;
- exact error positions (SRF-027);
- autocomplete for metric, label, attribute and value names, which must be scoped by RBAC;
- hover docs;
- formatting;
- explain (SRF-028);
- a visual builder that round-trips with the text (SRF-029);
- an auto-vis hint (SRF-030, VIZ-065);
- an AI hook.

[T01](T01-frontend-architecture.md) proposed reusing PulsusDB's own parser crates, so that client and
server agree byte-for-byte on what is valid. §4.1 records what those crates are today, measured
rather than assumed. Decision D3 settles their licensing: the Dash repository is **AGPL-3.0**, the
same as PulsusDB, so linking PulsusDB's AGPL parser crates into the Dash wasm and the BFF is
licence-compatible, and R17 (permissive syntax crates) drops to *nice-to-have*.

## 2. Goals / non-goals

**Goals**
- Parser parity with PulsusDB: a query the editor accepts is a query PulsusDB accepts, with the same
  error text.
- Keystroke → highlighted repaint within one frame. Diagnostics ≤ 50 ms after typing pauses.
- Context-aware completion on incomplete input, from static grammar knowledge, the entity catalogue
  ([T12](T12-entity-catalogue.md)) and live label and attribute values via the BFF.
- Native-quality IME, selection, screen-reader and mobile-keyboard behaviour.
- One editor core for the workbenches, alert rules, Board viewport editing, ⌘K and read-only
  snippets.
- A PromQL visual builder at M-UI1 that round-trips with the text on the same AST.

**Non-goals**
- A general code editor (multi-cursor, minimap, folding, Vim mode). Vim mode is a candidate later.
- SQL or other datasources (PRN-012: PulsusDB, plus Prometheus-API read-only sources later).
- Evaluating queries in the browser. That is T13 (draft) for local data, the BFF for virtual sources
  ([T07](T07-scene-query-planner.md) §4.11), and PulsusDB otherwise.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [SRF-027](../product/04-surfaces.md#srf-027--promql-editor) | §4.2, §4.3, §4.4, §4.5, T09-002, T09-009 | `e2e:editor-missing-brace`: typing `rate(http_server_duration_bucket{service="checkout"[5m])` underlines the missing `}` at its byte offset before run; `itest:editor-completion-metadata` (metric, label and value completion from seeded PulsusDB metadata); `unit:hover-docs-functions` |
| [SRF-028](../product/04-surfaces.md#srf-028--query-explain) | §4.5 (explain: structure + `X-Pulsus-Explain`) | `itest:explain-matches-headers` (T07 co-owns): rollup, rows read and server time match the PulsusDB response for a seeded 7-day query |
| [SRF-029](../product/04-surfaces.md#srf-029--visual-query-builder) | §4.9, T09-013 | `prop:builder-roundtrip`: for every query in the PromQL corpus the builder can represent, text → builder → text is AST-equal and builder → text → builder is identical; every unrepresentable query yields a reason |
| [SRF-030](../product/04-surfaces.md#srf-030--metrics-auto-vis-and-multiple-queries) | §4.6 (`VisHint`), §5.1 (multiple editors, A/B refs) | `e2e:metrics-autovis`: a histogram metric shows a heatmap; queries A, B and `A / B` show overlaid or as small multiples (T07 co-owns expression evaluation) |
| [SRF-031](../product/04-surfaces.md#srf-031--metric-browser-and-series-table) | §4.4 (metric browser source: names, type, cardinality, label value counts) | `itest:suggest-metric-browser`: `http_` lists matching metrics with type and series count; labels for the selection list value counts |
| [SRF-032](../product/04-surfaces.md#srf-032--cardinality-explorer) | §4.4 (`kind: cardinality`) | `itest:suggest-cardinality`: a seeded metric with 3.2k series, 2.9k from `pod`, returns `pod` as the largest entry with its count |
| [INT-038](../product/03-interaction-model.md#int-038--query-detection) | §5.1 (`QueryLanguage::detect`) | `unit:lang-detect`: `rate(`, `{app=`, `{ span.`, `process_cpu:` each score highest for PromQL, LogQL, TraceQL, profile selector; `e2e:palette-query-detect` (T08 co-owns) |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §4.6 (hint follows Table 5-13 order) | `unit:vishint-table-5-13`: one fixture query per row decidable from the query; T07/T02 confirm the remaining rows on result shape |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.2 (main-thread work bounded), §7 | `bench:editor-keystroke`: ≤ 2 ms main-thread work per keystroke on a 1 KB query; 0 long tasks during typing scripts |
| [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) | §4.2 (lazy `dash-editor.wasm`) | `ci:bundle-size`: parsers absent from the core module; a cold load that opens no editor fetches no editor satellite |
| [VL-010](../product/08-visual-language.md#vl-010--fonts) | §4.8 (JetBrains Mono for queries) | `golden:editor-fonts` |
| [AI-031](../product/06-ai-copilot.md#ai-031--query-assist-shows-the-query) | §4.7, T09-012 | `e2e:query-assist-shows-query`: "p99 latency of POST /pay by pod" puts a query in the editor, runs it only after confirmation in workbenches, and editing re-runs it |
| [ENT-006](../product/11-enterprise.md#ent-006--scoped-users-see-no-out-of-scope-data) | §4.4, §8, T09-014 | `itest:suggest-scoped`: a principal scoped to `env=staging` gets no prod label value, entity name or count from any `/suggest` kind |
| [ALR-085](../product/07-alerting.md#alr-085--history-queryable-as-telemetry) | §4.5 (virtual-source diagnostics, completion of reserved selectors) | `unit:virtual-diagnostics`: `rate(ALERTS[5m])` validates; a subquery over `ALERTS` shows the `virtual_unsupported` warning before run |

## 4. Design

### 4.1 The PulsusDB parser crates: what we measured

Inspected at upstream `digitalis-io/pulsusdb` `origin/main` `9aaa49d3` (2026-11-17). Built with rustc
1.93.0 (PulsusDB's pinned toolchain), `--target wasm32-unknown-unknown`, in a scratch copy.

| Crate | What it is | Runtime deps | wasm32 build | Size (cdylib exporting `parse` only; `opt-level=z`, LTO, gzip −9) | Native parse time (typical query) | Errors |
|---|---|---|---|---|---|---|
| `pulsus-logql` | Hand-written lexer + recursive-descent parser → `Expr` AST, with `Display` printer | `thiserror` only | **compiles** | 118 KB raw / **44 KB gz** | 2.6 µs | `LogQlError` with a structured byte `Span` on every variant |
| `pulsus-traceql` | Hand-written lexer + recursive descent → `Query`, with `Display`. `validate()` semantic pass | `pulsus-re2` → `regex`, `regex-syntax`; `thiserror` | **compiles** | parse only: 90 KB / **34 KB gz**. With `validate`: 972 KB / 332 KB gz (the `regex` Unicode tables) | 2.2 µs (first call 32 µs) | `TraceQlError::span()` on every variant |
| `pulsus-promql` | Thin wrapper over a **vendored, patched `promql-parser` 0.10.0** (GreptimeTeam, grmtools LR parser), *plus the whole evaluator and planner* | `promql-parser` (`lrpar`, `lrlex`, `cfgrammar`, `regex`, `chrono`, `lazy_static`), `pulsus-model` (`serde_json`, `http`, `xxhash`, `ch_cityhash102`), `pulsus-re2`, `regex` | **compiles** (dead-code elimination drops the evaluator) | 1.69 MB / **481 KB gz**. The bare vendored `promql-parser` is the same size: the LR tables + `regex` dominate | **115 µs** (first call 770 µs while LR tables initialise) | `PromqlError::Parse(String)`: the position is *in the message text* when the parser gives one, and sometimes absent (e.g. `"unclosed left parenthesis"`) |
| All three in one module | — | — | compiles | 1.86 MB / **541 KB gz** (brotli not measured; expect roughly 15–20 % smaller) | — | — |

Other findings that shape the design:
- **No error recovery in any of the three.** `promql-parser` is built with `RecoveryKind::None`. The
  LogQL and TraceQL parsers stop at the first error. They cannot tell us "where in the grammar the
  caret is" in an incomplete query, which is what completion needs.
- **Lexers are mostly private.** LogQL's `lexer` module is private. TraceQL exposes
  `Token`/`TokenKind` but its tokeniser is `#[doc(hidden)]` ("not a supported API surface").
  `promql-parser::parser::lex` is public. None of them is resumable mid-document.
- **AST spans.** The vendored PromQL AST carries the node *start* offset (a PulsusDB patch). The LogQL
  and TraceQL ASTs carry no spans; only tokens and errors do.
- **Coverage is close to full, despite stale doc comments.** `pulsus-logql`'s crate doc still says
  "M1 proof subset", but the code supports everything except the `ip` stage
  (`REMAINING_UNSUPPORTED_STAGES = ["ip"]`). Unsupported constructs come back as `NotYetSupported`,
  which the editor shows as "not yet supported by PulsusDB", not as a syntax error.
- **Corpora we can reuse for parity tests:** Prometheus v3.13 parse cases; the LogQL v3.7.4
  conformance registry; the TraceQL v3.0.2 registry and accept/reject corpus.
- **Formatting is available.** `promql-parser` has `Expr::prettify()`, and LogQL and TraceQL have
  canonical `Display` printers. None of them preserves PromQL `#` comments, which the lexer discards.
- **Query cap:** LogQL `MAX_QUERY_BYTES = 131 072`. We apply the same cap in the editor for all three.

**Licence (decision D3).** The three crates, `pulsus-re2` and `pulsus-model` are `AGPL-3.0-only`
(the PulsusDB workspace licence); the vendored `promql-parser` keeps its Apache-2.0 headers. Dash is
AGPL-3.0, so linking them into the Dash wasm (shipped to every browser) and into the BFF forms a
combined AGPL work, which is compatible: Dash publishes its source. The crates are linked **by
default**. [R17](pulsusdb-requirements.md) (permissively licensed syntax-only crates, and confirmation
of the licence of PulsusDB's patches to the vendored `promql-parser`) stays open as a P3
nice-to-have, relevant only if a non-AGPL Dash edition is ever planned.

#### T09-001 — PulsusDB crates sit behind one trait
**MUST** — The PulsusDB parser crates MUST be named only in the `dash-lang` crate, behind the
`QueryLanguage` trait (§5.1). Every other crate (editor, planner, scope rewriter preview, ⌘K) MUST
use the trait, so a different implementation is a crate swap, not a redesign.

### 4.2 Architecture: three layers, two threads

```
 main thread (dash-shell)                                    EDITOR worker: dash-editor.wasm (lazy)
 ┌──────────────────────────────────────────────┐            ┌─────────────────────────────────────────┐
 │ <textarea> bridge  ──input──► EditBuffer      │  EditMsg   │ pulsus-promql/logql/traceql  (validate) │
 │ (native IME, caret,          │ (String +      ├───────────►│ dash-qctx tolerant context parser       │
 │  selection, a11y)            │  LineIndex)    │            │ formatter (prettify / Display + comments)│
 │                              ▼                │            │ completion engine + suggest cache        │
 │ dash-qlex highlight lexer (sync, resumable)   │◄───────────┤ hover/explain resolver · VisHint · builder│
 │ underlay <pre> spans ◄─ HighlightRuns         │ LangReply  └───────────────┬─────────────────────────┘
 │ completion popup / hover card / squiggles     │                            │ debounced fetch
 └──────────────────────────────────────────────┘                            ▼
                                                                 BFF /api/dash/v1/suggest (scope-rewritten)
```

- **Layer 1: `dash-qlex`.** Our own highlighting lexers, one per language and about 1–2k lines in
  total. They are error-tolerant (they never fail; unknown bytes become `TokenClass::Error`) and
  **resumable**: line-start state is stored per line, so after an edit we re-lex from the edited line
  until the state converges with the old one. That is O(edited lines) in practice. They run
  synchronously on the main thread for zero-latency colour, and are ≤ 60 KB brotli for all three.
  On every corpus in §4.1, `dash-qlex` token boundaries must match PulsusDB's tokens (PromQL via the
  public `lex`; LogQL and TraceQL via a test-only harness).
- **Layer 2: `dash-qctx`.** A tolerant, error-recovering context parser. It walks `dash-qlex` tokens
  with a bracket and mode stack and produces a `CaretContext` (§4.4) plus a coarse node tree with
  spans. That tree gives LogQL and TraceQL the spans their ASTs lack, which hover, explain and
  matching-bracket need. It uses panic-mode recovery at synchronising tokens: `}` `)` `]` `|` `,`
  `by` `without` `&&` `||` and newline.
- **Layer 3: the PulsusDB parsers (authority).** They run in the editor worker after every edit
  (≤ 0.4 ms even for PromQL in wasm, estimated at 2–3× native).

**Why a worker?** The parsers are about 0.5 MB gz, and that must not sit in the 3 MB core module
(PRF-009). The first PromQL parse takes 0.8 ms or more while the LR tables initialise. The worker
loads on the first editor focus (or ⌘K query detection) and is warm before the user finishes typing
the first token. Highlighting never waits for it.

#### T09-002 — The PulsusDB parser is the only authority on validity
**MUST** — Whether a query is valid MUST be decided only by the PulsusDB parser for its language.
`dash-qlex` and `dash-qctx` MAY drive colour, completion, spans and recovery points, but MUST NOT mark
a query valid or invalid.

#### T09-003 — Highlighting never waits
**MUST** — Highlighting MUST run synchronously on the main thread from `dash-qlex`, re-lexing only
from the edited line to state convergence, within ≤ 2 ms per keystroke for a 1 KB query. It MUST NOT
wait for the editor worker.

### 4.3 Editor surface: textarea bridge (decision)

| Option | IME | Screen reader | Mobile keyboards | Decorations | Effort |
|---|---|---|---|---|---|
| **A. Transparent `<textarea>` over a highlighted `<pre>` underlay** | native | native (it *is* a textarea) | native | spans, squiggles, bracket marks; no inline widgets that shift text | low |
| B. `contenteditable` + `beforeinput` interception (the model of mature JS code editors) | hard: composition mutates the DOM and must be reconciled per browser | good if done right | quirky | anything | high |
| C. Canvas-text editor (GPU text) | must re-implement through a hidden input | must be re-implemented | poor | anything | very high |

**Decision: A.** Queries are short and plain-text. The textarea gives us correct IME, spell-check-off,
selection, drag-drop, undo intents, mobile keyboards and AT behaviour for free. This replaces the
"contenteditable bridge" wording in [T01](T01-frontend-architecture.md).

#### T09-004 — Textarea overlay surface
**MUST** — Query editing MUST use a native `<textarea>` overlaid on a highlighted underlay. Editors
MUST NOT use `contenteditable` or canvas text input.

Mechanics:
- **Pixel alignment.** The textarea and the underlay share font (JetBrains Mono), size, line-height,
  padding, `white-space: pre-wrap`, `overflow-wrap: anywhere`, `tab-size` and width. The textarea's
  text is `color: transparent` with a visible `caret-color`. Its scroll is mirrored to the underlay on
  `scroll`. The editor auto-grows up to 12 lines, then scrolls.
- **Edits.** On `input`, Rust reads `value` and computes a prefix/suffix diff against `EditBuffer`
  (O(n), n ≤ 128 KB; typically < 1 KB), producing `TextEdit { range, insert }`. Diffing the whole
  value is robust to IME, autocorrect, paste and drag-drop, where interpreting `beforeinput` intents
  is not.
- **Buffer.** `EditBuffer` is a `String` plus `LineIndex` (a `Vec<u32>` of line starts, updated
  incrementally) and a version counter. A rope (`ropey`) is unnecessary under the 128 KB cap; a
  `String` splice is microseconds.
- **Programmatic edits** (completion accept, format, AI insert, builder sync) use `setRangeText()`.
- **Ghost-text completion** shows only when the caret is at the end of a line. Elsewhere it would
  shift underlay text relative to the textarea.
- **Keys.** The editor is the 03 **Text input** context ([T08](T08-dom-component-kit.md) §4.8):
  `⌘⏎` runs, `⌘⇧F` formats, `Esc` leaves the field (closing an open completion popup first), `⌘Z`
  and `⌘⇧Z` undo and redo typing, and `⌘K` opens the palette. `Tab`/`Enter` accept a completion only
  while the popup is open; otherwise `Tab` moves focus, so the editor is never a keyboard trap.

#### T09-005 — Composition is respected
**MUST** — During composition (`compositionstart` → `compositionend`) the editor MUST keep
re-highlighting but MUST NOT open, accept or reorder completions and MUST NOT reformat. Completion
re-evaluates on `compositionend`.

#### T09-006 — One undo history
**MUST** — Native and programmatic edits MUST share one undo history: programmatic edits are pushed
to the editor's own stack, and `beforeinput` `historyUndo`/`historyRedo` plus `⌘Z`/`⌘⇧Z` are
intercepted so both kinds undo in order.

### 4.4 Completion

`dash-qctx` classifies the caret into one of these contexts:

```rust
pub enum CaretContext {
    MetricName { prefix: String },                                   // PromQL bare identifier (incl. reserved virtual names)
    FunctionOrKeyword { prefix: String, expects: ValueTypeSet },     // rate(, sum by, offset, @
    LabelName { selector: SelectorSketch, prefix: String },          // after `{` or `,`
    LabelValue { selector: SelectorSketch, label: String, op: MatchOp, prefix: String }, // after `="`
    GroupingLabel { inner: Option<SelectorSketch>, prefix: String }, // `by (`
    Duration { prefix: String },                                     // inside `[` / after offset
    LogPipelineStage { prefix: String },                             // after `|` in LogQL
    LogField { stream: SelectorSketch, prefix: String },             // label filter after a parser stage
    TraceAttribute { scope: Option<AttrScope>, prefix: String },     // after `.`, `span.`, `resource.`
    TraceAttrValue { scope: Option<AttrScope>, attr: String, prefix: String },
    TraceIntrinsic { prefix: String },                               // name, duration, status, kind
    BoardVariable { prefix: String },                                // `$`, `${`
    None,
}
```

`SelectorSketch` is the best-effort set of complete matchers in the enclosing selector. It scopes
value lookups, so `{service="checkout", pod=~"|` only suggests checkout's pods.

| Source | Contexts | Latency path |
|---|---|---|
| Static grammar tables (functions with signatures, aggregations, LogQL stages and parsers, TraceQL intrinsics and enum values, duration units, reserved virtual selectors `ALERTS`, `ALERTS_FOR_STATE`, `pulsus_anomaly_score`, `{source="pulsus-dash"}` with their labels) | all of the above | local, same frame |
| Entity catalogue ([T12](T12-entity-catalogue.md) local index) | label values for entity-identity labels (`service`, `namespace`, `k8s.*`), mapped through the label ⇄ attribute table ([02 §5](../product/02-information-architecture.md), IA-027) | local |
| Metric names + metadata (type, help, unit) + series count | `MetricName`, hover, metric browser (SRF-031) | BFF `/suggest` `metric_names` → PulsusDB `/api/v1/label/__name__/values`, `/api/v1/metadata`, `/api/v1/status/tsdb` |
| Metric label names/values (with value counts) | `LabelName`, `LabelValue`, `GroupingLabel`, metric browser | `/api/v1/labels?match[]=`, `/api/v1/label/{name}/values?match[]=` |
| Cardinality by label (SRF-032) | cardinality explorer | `/suggest` `cardinality` → `/api/v1/status/tsdb` and per-label `count by` over `/api/v1/series` (capped) |
| Log labels/values | LogQL `LabelName`/`LabelValue` | `/api/logs/v1/labels`, `/api/logs/v1/label/{name}/values?query=` |
| Log detected fields | `LogField` | `/api/logs/v1/detected_fields?query=` (and `/detected_field/{name}/values`) |
| Trace tags/values | `TraceAttribute`, `TraceAttrValue` | `/api/traces/v1/tags?scope=`, `/api/traces/v1/tag/{tag}/values?q=` |
| Profile types/labels | profile selectors | `/api/profiles/v1/types`, `/labels`, `/label/{name}/values` |
| Virtual-source labels/values (`alertname`, `severity`, `team`…) | `LabelName`/`LabelValue` inside a reserved selector | `/suggest` → Postgres via `dash-vsrc` (T07 §4.11), never PulsusDB |
| User history | everything | local (last 500 queries per language, IndexedDB) |

- **Ranking:** (1) exact prefix; (2) word-boundary prefix; (3) fuzzy (`nucleo-matcher`). Each tier is
  boosted by user history recency, the current Context's entities (a value matching a Context entity
  goes first), and the catalogue care score for entity labels. Cardinality appears as detail ("3.2k
  series"), as in the [04 §4.4](../product/04-surfaces.md) metric browser.
- **Limits.** At most 200 items per remote response, with `complete: false` shown as "type to narrow".
- **Scope.** Families withheld by the principal's metrics scope (T07-015) are listed with "withheld
  by scope" and no series count.

#### T09-007 — Completion fetches by context key, debounced and cancellable
**MUST** — Local sources MUST answer in the same frame. Remote lookups MUST be debounced 120 ms after
the last keystroke, MUST be fetched for the *context key* (e.g. "values of `pod` under
`{service="checkout"}` in this window bucket") rather than the prefix and then filtered locally, and
a superseded lookup MUST be cancelled (the BFF propagates cancellation, [T06](T06-bff-architecture.md)
§4.3).

**Cache.** An LRU of 2 000 context keys in the editor worker, with a 60 s TTL. Each key is
`(tenant, scope_fp, lang, kind, label, selector_hash, window_bucket)`; the window is bucketed to
15 min so nearby windows share entries. The BFF has its own L1 metadata cache with a 30–60 s TTL
([T06](T06-bff-architecture.md) §4.4).

#### T09-008 — Late completions do not move the selection
**MUST** — Remote completion results arriving after the popup opened MUST NOT reorder items at or
above the highlighted item (the same rule as T08-014).

### 4.5 Diagnostics, hover docs, formatting, explain

- **Diagnostics come in four severities:**
  - *error*: from the PulsusDB parser;
  - *not supported*: `NotYetSupported`, naming the construct;
  - *virtual unsupported*: a construct outside the BFF's virtual-source subset or join limits
    (T07 §4.11), e.g. a subquery over `ALERTS` or a range function over a mixed expression, shown as a
    warning before run;
  - *warning*: semantic checks from metadata. Examples: `rate()` over a gauge; a counter used without
    `rate`; `histogram_quantile` without `le` in `by`; an unknown metric or label in the window; a
    regex RE2 would reject (the same `pulsus-re2` screen PulsusDB uses); a step finer than the
    `rollupLevels` exposed by `/api/v1/status/runtimeinfo`.

  Each diagnostic carries a span, a message key and optional quick-fixes (`TextEdit`s), such as
  "wrap in `rate(…[$__rate_interval])`". Squiggles use the wavy `text-decoration` in the underlay. A
  gutter glyph and an `aria-describedby` list give the non-visual channel.

#### T09-009 — Error positions are byte offsets
**MUST** — Each parser error MUST be shown at a byte offset: the structured span for LogQL and
TraceQL; for PromQL, the position parsed out of the message. When PromQL gives no position, the
squiggle MUST be placed at the `dash-qctx` recovery point and labelled "approximate position".

**Board variables and macros** (`$var`, `${var}`, `$__rate_interval`, `$__interval`) are not PulsusDB
syntax.

#### T09-010 — Variables are substituted with an offset map
**MUST** — Before validation, `dash-qctx` MUST substitute each variable or macro with a type-correct
placeholder (a duration for `[$__rate_interval]`, a string inside quotes, a regex alternation for
multi-value), keep an offset map, and map errors back to the original text. This mirrors what the BFF
does before execution ([T07](T07-scene-query-planner.md) §4.1).

- **Hover docs.**
  - **Functions and keywords:** from `dash-qdocs`, written by us. Prometheus docs (Apache-2.0) are
    adapted with attribution. Loki and Tempo docs are AGPL-licensed; under D3 they MAY be adapted
    with attribution and licence notice, but our own text is preferred so the three languages read
    consistently.
  - **Metrics:** type, unit, help and series count (from `/api/v1/metadata` and BFF cardinality).
  - **Label values:** series or stream count.
  - **Durations:** the resolved value and its relation to the current step ("5m = 20 × step").
  - **`$__rate_interval`:** its resolved value.
  - **Reserved virtual selectors:** "served by Dash from alert history (Postgres)", with the
    supported subset.
- **Format / prettify** (`⌘⇧F`, and on save in alert rules):
  - **PromQL:** `promql-parser`'s `prettify()`. If the text contains `#` comments, formatting is
    refused with "format would drop comments" (§13 Q2).
  - **LogQL and TraceQL:** the crates' canonical `Display`, plus our line-breaking pass (pipeline
    stages on new lines past 80 columns).

#### T09-011 — Formatting preserves meaning
**MUST** — Formatting MUST satisfy `parse(format(q)) ≡ parse(q)` (AST-equal) and
`format(format(q)) == format(q)`, and MUST be refused when it would drop comments.

- **Explain** (SRF-028) has two parts:
  1. *Structure*: `dash-qctx` node spans, rendered as nested annotated boxes under the editor
     ("`rate(…[5m])`: per-second increase, counter").
  2. *Execution*: the BFF runs the query with `X-Pulsus-Explain: 1` and returns the rollup choice,
     stages, `exactness`, rows read and server time ([04 §4.4](../product/04-surfaces.md)), attached
     to the same node spans. The planner's plan view ([T07](T07-scene-query-planner.md) §4.10) is
     linked from it. For virtual sources the execution part shows the Postgres table and the BFF
     evaluation time instead.

### 4.6 Query → auto-vis hint

The editor worker derives a `VisHint` from the AST plus metadata *before* results arrive, so the
viewport can create the right vis spec immediately. It applies [05](../product/05-visualisation-catalogue.md)
Table 5-13 top to bottom, for the rows decidable from the query and metadata; rows that depend on the
result (lines > 10k, single value, geo fields, state-like values, series count > 50, many columns)
are confirmed or overridden by [T07](T07-scene-query-planner.md)/[T02](T02-vis-engine.md) on result
shape (VIZ-065). A user override persists with the viewport and suppresses the hint.

```rust
pub struct VisHint { pub primary: VisKind, pub alternatives: SmallVec<[VisKind; 4]>, pub rule: u8 /* Table 5-13 row */, pub reason: MsgKey, pub confidence: f32 }
```

| Query shape | Table 5-13 row | Hint |
|---|---|---|
| Profile selector | 2 | flame graph |
| TraceQL search | 3 | span scatter + RED summary |
| LogQL log query | 4 (confirmed on line count) | volume + patterns (stream on demand) |
| PromQL selector on a `histogram`-typed or `_bucket` metric, no `histogram_quantile` | 5 | heatmap (+ quantile-lines option) |
| Counter-typed selector without `rate`/`increase` | 6 | rate line + quick-fix warning |
| Instant query, or top-level scalar / `count()` with no `by` | 7 (confirmed on result) | stat (bullet if a threshold exists) |
| `topk`/`bottomk`/`sort*` with an instant query | 11 | bar chart |
| TraceQL `compare()` | 11 | compare bars |
| LogQL metric query | 14 | bars over time when `count_over_time`, else line |
| TraceQL `histogram_over_time` / `quantile_over_time` / `rate` | 5 / 14 / 14 | heatmap / line / line |
| `histogram_quantile(...)`, gauge, other time series | 14 | line |

### 4.7 AI "explain / generate query" hook

- **Explain** (the ✦ button in the editor toolbar, or the ⌘K action "Explain query"; the 03 `.` key
  is a Space-context binding and types a period inside the editor): sends `{lang, text, ast_sketch,
  metadata snippets, Context}` to T15 (draft). The response is a list of `(span, explanation)`
  rendered with the structural explain UI. Only the query and metadata go to the model; no telemetry
  values do.
- **Generate** ("p99 latency of POST /pay by pod", from ⌘K or the editor): T15 returns query text.

#### T09-012 — AI-generated queries are shown, parsed and confirmed
**MUST** — A generated query MUST be parsed with the PulsusDB parser before it is shown (one repair
round trip to T15 on failure, then shown with diagnostics), MUST be shown in the editor as a diff or
insert preview marked ✦ AI-generated, and MUST NOT be auto-run in alert-rule or Board editors. In
workbenches it runs after the user confirms (`⌘⏎`) and re-runs on edit; results are never shown
without the query (AI-031).

- **Scope.** Data scope is enforced server-side on execution as always. The AI cannot widen it by
  writing a matcher-free query ([11 §3.2](../product/11-enterprise.md)).

### 4.8 Rendering highlights

- `HighlightRuns` = `Vec<(u32 start, u32 len, TokenClass)>` per line. The underlay is a keyed list of
  line elements, so only changed lines re-render (Leptos keyed `For`).
- `TokenClass` maps to syntax tokens in `dash-tokens` (`--syn-metric`, `--syn-label`, `--syn-string`,
  `--syn-number`, `--syn-duration`, `--syn-func`, `--syn-keyword`, `--syn-op`, `--syn-error`,
  `--syn-var`, `--syn-virtual`), designed for dark, light and high-contrast themes
  ([T08](T08-dom-component-kit.md) §4.7). Query text uses JetBrains Mono (VL-010).
- **Bracket matching:** the bracket pair at the caret, plus mismatched-bracket marks. **Occurrence
  highlighting:** the same label name everywhere in the query.
- **Read-only snippets** (Inspector, ⌘K results, AI dock, Investigation evidence) use the same lexer
  with no textarea.
- **Canvas labels** that show queries pass `HighlightRuns` to GPU text as per-glyph colour
  ([T02](T02-vis-engine.md)).

### 4.9 Visual query builder (PromQL at M-UI1)

SRF-029 requires a builder (metric → filters → operations) as a toggle that round-trips with the text
without loss for any query it can represent.

- **Model.** `BuilderModel` is a projection of the PulsusDB PromQL AST, not a separate grammar:
  `metric` (with type and unit from metadata), `filters: Vec<Matcher>` (label pickers backed by
  `/suggest`), and an ordered `ops: Vec<Op>` pipeline, where `Op` ∈ range function (`rate`,
  `increase`, `*_over_time` with a duration), aggregation (`sum`/`avg`/`min`/`max`/`count`/`topk`/
  `bottomk` with `by`/`without`), `histogram_quantile(φ)`, scalar arithmetic and comparison with a
  constant, and binary operation with another builder query (`A / B`, with `on`/`ignoring`).
- **Text → builder.** `project(&Expr) -> Result<BuilderModel, Unrepresentable>` walks the AST from the
  outermost node inwards. `Unrepresentable` names the reason (e.g. "subquery", "nested binary
  operation with vector matching on both sides", "`label_replace`", "offset/@ modifiers inside an
  aggregation"), and the toggle shows it instead of switching.
- **Builder → text.** `print(&BuilderModel) -> Expr` builds the AST and prints it with the canonical
  printer; the textarea is updated with `setRangeText()` as one undoable edit.
- **Loss check.** Every toggle checks `parse(print(project(q))) ≡ parse(q)` before switching; if it
  fails, the toggle reports the construct and stays on text. Formatting differences (whitespace,
  matcher order) are not loss; comments are, so a query with `#` comments is unrepresentable.
- **Accessibility.** The builder is kit form controls (comboboxes, lists with reorder buttons), fully
  keyboard-operable ([T08](T08-dom-component-kit.md)).
- LogQL and TraceQL builders follow at M-UI5 on the same pattern.

#### T09-013 — Builder round-trips or explains
**MUST** — Toggling from text to the builder MUST either produce a model whose printed AST equals the
original AST, or refuse with a named reason. Toggling from the builder to text and back MUST restore
an identical builder state.

## 5. Interfaces

### 5.1 Defined here

```rust
/// Implemented once per language in dash-lang; the only place the PulsusDB crates are named (T09-001).
pub trait QueryLanguage {
    const LANG: Lang;                                   // PromQL | LogQL | TraceQL | ProfileSelector
    fn validate(&self, text: &str) -> Vec<Diagnostic>;  // authority: PulsusDB parser
    fn format(&self, text: &str) -> Result<String, FormatRefusal>;
    fn vis_hint(&self, text: &str, meta: &MetaView) -> Option<VisHint>;
    fn detect(prefix: &str) -> f32;                     // ⌘K language detection score (INT-038)
}
```

| Interface | Consumers |
|---|---|
| `QueryEditor` Leptos component (`lang`, `value: RwSignal<String>`, `on_run`, `read_only`, `vars: VarScope`, `ref_name: Option<char>` for A/B/…) | T08 rooms, workbenches (multiple editors A, B, … and expression editors, SRF-030), alert-rule room (T16), Board editor |
| `QueryBuilder` Leptos component (`model: RwSignal<BuilderModel>`, bound to a `QueryEditor`) | Metrics workbench (M-UI1) |
| `highlight(lang, &str) -> HighlightRuns` (sync, main thread) | T08 (snippets, ⌘K), T02 (canvas labels) |
| `LangMsg`/`LangReply` (shell ⇄ editor worker, `postcard`): `Edit{doc, version, edits}`, `Complete{doc, version, caret}`, `Hover{doc, offset}`, `Format{doc}`, `Explain{doc}`, `Project{doc}`, `Print{model}` → `Diagnostics`, `Completions`, `HoverCard`, `Formatted`, `VisHint`, `Builder`, `Text` | internal; worker topology from T03 |
| `VisHint` | T07 (planner), T02 (vis spec selection) |
| **`POST /api/dash/v1/suggest`** (served by [T06](T06-bff-architecture.md) §5.1) | editor worker, metric browser, cardinality explorer |

```
POST /api/dash/v1/suggest
{ "lang":"promql", "kind":"label_values", "label":"pod",
  "match":"{service=\"checkout\"}", "from":…, "to":…, "limit":200 }
→ 200 { "items":[{"v":"checkout-7f9c-2xq","detail":"412 series","count":412}…], "complete":false, "scope_applied":true }
```

`kind` ∈ `metric_names`, `metric_metadata`, `label_names`, `label_values`, `cardinality`,
`log_labels`, `log_label_values`, `detected_fields`, `detected_field_values`, `trace_tags`,
`trace_tag_values`, `profile_types`, `profile_labels`, `profile_label_values`. Each maps to the
endpoints in §4.4. Requests whose `match` names a reserved virtual selector are answered from
Postgres by `dash-vsrc`.

#### T09-014 — Suggestions are scope-rewritten server-side
**MUST** — Every remote suggestion MUST be computed by the BFF under the caller's data scope
(`ScopeRewriter`, [T06](T06-bff-architecture.md) §5.5) by injecting matchers into `match[]`/`query`,
so a user never sees label values, metric names or counts outside their scope. The editor-worker
cache MUST be keyed by tenant and `scope_fp` and cleared on logout or tenant switch.

### 5.2 Cross-doc interfaces (assumed)

| From | Assumption |
|---|---|
| [T03](T03-browser-runtime.md) | The `dash-editor.wasm` satellite in its own `editor` worker with its own memory, loaded on first focus of a query bar, and a message channel to the shell. `dash-lang` is the crate compiled into it. The highlight lexer `dash-qlex` is linked into `dash-shell.wasm` |
| [T06](T06-bff-architecture.md) | Implements `/suggest`, with its metadata cache, cancellation and scope rewriting. `X-Pulsus-Explain` passthrough on run |
| [T07](T07-scene-query-planner.md) | Virtual-source subset and join limits (§4.11) for the *virtual unsupported* diagnostics; plan explain view |
| [T12](T12-entity-catalogue.md) | A local catalogue index exposing entity identity values per label/attribute name, and the label ⇄ attribute map |
| T15 (draft) | `POST /api/dash/v1/ai/query/{explain,generate}`, which returns spans or text and records an audit entry |
| [T08](T08-dom-component-kit.md) | Textarea styling tokens, the dock host, the undo key routing, the keymap context `TextInput(QueryEditor)`, and kit form controls for the builder |

## 6. Data & storage

| Data | Where |
|---|---|
| Query text | The owning object: Board viewport and alert rule in Postgres ([T11](T11-postgres-schema.md)), workbench state in the URL/Context |
| Query history (last 500 per language per user) | IndexedDB, plus optional server sync in user prefs |
| Suggest cache | editor-worker memory (LRU 2k keys) + BFF L1 |
| Function docs, grammar tables | Compiled into `dash-lang` |

## 7. Performance budget

| Metric | Target | Notes |
|---|---|---|
| Keystroke → highlighted repaint | ≤ 1 frame; ≤ 2 ms main-thread work for a 1 KB query | resumable lexer, keyed lines (PRF-005) |
| Keystroke → diagnostics visible | ≤ 50 ms after a 30 ms idle | PromQL parse estimated ≤ 0.4 ms in wasm; measured in M-UI1 |
| Local completions | ≤ 16 ms from keystroke | — |
| Remote completions (cache miss) | ≤ 150 ms p50 / 400 ms p95 after the debounce | BFF L1 hit typical |
| Builder toggle (project + loss check) | ≤ 16 ms for a 1 KB query | editor worker |
| Editor-worker cold start (fetch + compile + LR init) | ≤ 300 ms on (b), overlapped with first focus | ~0.45–0.55 MB br estimated (PRF-009: not in core) |
| Main-thread code for editors | ≤ 60 KB br (`dash-qlex` + component) | in the core module |
| Max query size | 128 KB (LogQL cap applied to all three) | T09-015 |

These are measured with Playwright typing scripts (per-keystroke frame timing) and a corpus replay of
10k real queries through the editor worker ([T05](T05-testing-and-performance.md)).

#### T09-015 — Query size cap
**MUST** — The editor MUST allow editing of any length but MUST pause validation and completion above
128 KB, with an explanation, and the run action MUST refuse such a query with the same message.

## 8. Security, tenancy & RBAC

- **Suggestions are data.** Label values can reveal customer names, hosts or tenants, so every remote
  suggestion is scope-rewritten in the BFF (T09-014).
- **AI calls** send query text and metadata only, under the T15 (draft) redaction policy. The audit
  log records generate and explain calls.
- **No query text in the URL for alert rules** (they are referenced by id). Workbench queries are in
  the URL by design ([02 §4](../product/02-information-architecture.md)), and share links obey the
  same RBAC.

#### T09-016 — Regex screening
**MUST** — Matcher regexes MUST be screened in the editor worker with `pulsus-re2`'s compile budget,
the same bound PulsusDB applies, and a regex that fails the screen MUST be a diagnostic, not a run
error.

## 9. Failure modes & degradation

| Failure | What the user sees |
|---|---|
| Editor worker fails to load | Highlighting still works (main thread). The status pip says "validation offline"; run still works and the server error is shown positioned by parsing its message |
| `/suggest` slow or down | Static and catalogue completions only, with the hint "live values unavailable" |
| PulsusDB parser gives no position (PromQL) | Squiggle at the `dash-qctx` recovery point, marked "approximate" |
| Client accepts but server rejects (version skew) | The server error is shown inline with "Dash and PulsusDB disagree: report" (telemetry counter). This is caught early by the parity CI below |
| Query over 128 KB | Editing is allowed. Validation and completion pause, with an explanation (T09-015) |
| Builder cannot represent the query | The toggle stays on text and names the construct (T09-013) |

## 10. Testing

#### T09-017 — Parity CI gates PulsusDB bumps
**MUST** — Every change of the pinned PulsusDB revision MUST run the three upstream corpora (§4.1)
through `dash-qlex` (token boundaries equal PulsusDB's), `dash-qctx` (never panics, recovers on every
reject case), the formatter (T09-011) and the builder (T09-013), and MUST fail on any mismatch. The
same job pins the PulsusDB git revision Dash builds against.

- **Fuzzing** (`cargo-fuzz`, native) of `dash-qlex` and `dash-qctx` for panics and for
  resumable-lexer equivalence (incremental == full re-lex) (`fuzz:qlex`, `fuzz:qctx`).
- **Completion golden tests:** caret-annotated fixtures (`sum by (|) (rate(x{a="b"}[5m]))` →
  `GroupingLabel`) (`golden:completion-contexts`).
- **IME and AT:** Playwright CDP composition scripts (ja, zh, ko), plus manual VoiceOver/NVDA passes
  in the editor and the builder (`e2e:editor-ime`, `a11y:axe-editor`).
- **Server-error parity:** a live job sends 1 000 invalid queries to a test PulsusDB and asserts the
  same message and position as the client (`itest:server-error-parity`).
- **Scope:** `itest:suggest-scoped` for every `/suggest` kind.

## 11. Rollout

| Milestone | Ships |
|---|---|
| M-UI1 | PromQL: textarea bridge, `dash-qlex`, `dash-qctx`, PulsusDB validation in the editor worker, metric/label/value completion via `/suggest`, metric browser and cardinality kinds, hover for functions and metrics, prettify, `VisHint`, explain (structure + `X-Pulsus-Explain`), **visual builder**, multiple editors A/B with expressions; ⌘K detection for PromQL |
| M-UI2 | LogQL and TraceQL (incl. detected fields and tags), profile selectors, ⌘K detection for all four, history |
| M-UI4 | Alert-rule editor integration (quick-fixes, variables), AI explain/generate, virtual-source completion and diagnostics |
| M-UI5 | LogQL/TraceQL builders, Board variables UI |

**Build features.** The PulsusDB crates are linked by default (`pulsusdb-parsers`, default on). A
permissive fallback build (upstream crates.io `promql-parser`; LogQL and TraceQL validation via BFF
round trips) is **optional**: it is not part of CI and is only revived if a non-AGPL edition is
planned (D3, R17).

## 12. Alternatives considered

| Option | Why not |
|---|---|
| contenteditable bridge (T01 wording) | Cross-browser composition reconciliation is the hardest part of mature JS code editors and buys nothing for short plain-text queries. See §4.3 |
| Canvas-text editor | Would re-implement IME, selection, a11y and mobile input |
| Use PulsusDB parsers for highlighting too | Lexers are private or doc-hidden and not resumable; PromQL costs 115 µs or more per parse. Fine for validation, wrong for per-keystroke colour |
| Tree-sitter grammars (compiled to wasm) | Excellent incremental parsing, but it is a second grammar to keep at parity, a C toolchain in the build, and the Prometheus/Loki/Tempo community grammars lag. `dash-qctx` is smaller and tested against PulsusDB corpora |
| Server-side language server over WS | Every keystroke would wait on the network (PRF-006) |
| `ropey` rope | Unnecessary below the 128 KB cap |
| Clean-room LogQL/TraceQL parsers plus upstream `promql-parser` (draft licence option 2) | No longer needed under D3; about 3–4 engineer-months plus a permanent parity burden |
| Builder with its own grammar | Two sources of truth; projecting the PulsusDB AST makes round-trip loss checkable |

## 13. Open questions

| # | Question | Leaning |
|---|---|---|
| Q1 | Will PulsusDB expose resumable public lexers and AST spans for LogQL/TraceQL (R17 nice-to-haves)? | Nice to have. `dash-qlex`/`dash-qctx` don't depend on it |
| Q2 | Comment-preserving PromQL formatting | Re-attach `#` comments by token position in our own printer (M-UI4), or refuse as now |
| Q3 | Should `/suggest` responses be Arrow for very large value sets? | No: ≤ 200 items as JSON is fine (config-like, [ADR-0005](../adr/0005-arrow-wire-format.md)) |
| Q4 | Builder coverage for binary operations with vector matching on both sides | Unrepresentable in v1; revisit with usage data |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; rules T09-001…T09-017. **D3:** the AGPL PulsusDB parser crates are linked by default; the licence analysis and Q8/Q1 are closed; `QueryLanguage` kept (T09-001); the permissive fallback build is optional and leaves CI; R17 is a P3 nice-to-have. **SRF-029:** the PromQL visual builder moves from M-UI5 to M-UI1 (§4.9). Added `cardinality`/metric-browser `/suggest` kinds (SRF-031, SRF-032), virtual-source completion and *virtual unsupported* diagnostics (ADR-0012), Table 5-13 row numbers on `VisHint` (VIZ-065), scope-keyed suggest cache. AI explain moved off the `.` key (a Space-context binding in 03) to the ✦ button and a ⌘K action. Draft Q4 (04 wording on positioned errors) closed: SRF-027's note now matches |
