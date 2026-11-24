# T09 — Query editors: PromQL, LogQL, TraceQL

| | |
|---|---|
| **Status** | Review |
| **Version** | 1.22-rc · 2026-11-24 |
| **Milestone** | M-UI1 (PromQL editor, errors on run, completion, explain, visual builder, auto-vis hint; LogQL validation on run and label/value completion for LogQL panels) → M-UI2 (pre-run positioned diagnostics and formatting from the WASM parser crates (SRF-078), LogQL detected fields, LogQL ⌘K detection, TraceQL, profile selectors, ⌘K detection for all four, history) → M-UI4 (alert-rule editor, AI explain/generate, virtual-source diagnostics) → M-UI5 (Board variables UI, LogQL/TraceQL builders) |
| **Related ADRs** | [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md) (supersede ADR-0001, ADR-0002 and ADR-0004), [ADR-0012](../adr/0012-derived-state-in-postgres.md), [ADR-0018](../adr/0018-query-language-modules.md), [ADR-0021](../adr/0021-query-planning-is-server-side.md) |
| **Source draft** | plans/tech/T09-query-editors.md (not tracked) |

## 0. Applicability under ADR-0014 and ADR-0015 (2026-11-19)

The editor is TypeScript on CodeMirror 6 ([ADR-0014](../adr/0014-typescript-react-web-client.md)
§1), and the BFF is Go ([ADR-0015](../adr/0015-go-bff.md)) and parses PromQL only to plan it
([ADR-0021](../adr/0021-query-planning-is-server-side.md)); PulsusDB stays the authority on validity
(T09-002). PulsusDB's parser is reached **through the BFF** first and, later, **in the browser** as
PulsusDB's parser crates compiled to WASM. Requirements, rules and budgets stand except where
revised below.

| Was (Rust/Leptos) | Now (TS, under `client/src/editor/`) |
|---|---|
| `dash-lang` crate and `QueryLanguage` trait (T09-001) | `lang/` with a TS `QueryLanguage` interface (§5.1); implementations `RemoteValidator` (BFF → PulsusDB) now and `WasmValidator` (PulsusDB crates in an editor worker) later |
| Textarea overlay (§4.3, T09-004) | CodeMirror 6 (§4.3, T09-004 revised) |
| `dash-qlex` highlight lexers | PromQL: the upstream open-source Lezer PromQL grammar (Apache-2.0, on the `client/dependency-policy.json` allowlist), incremental and error-tolerant. LogQL and TraceQL: in-house CodeMirror stream tokenizers implementing the `dash-qlex` design (resumable per line, never fail). PromQL v1 (#63): `@prometheus-io/codemirror-promql` supplies the Lezer language with its completion and linter off; completion is our `CompleteStrategy` (`lang/promql/promClient.ts`) behind a guard, over the BFF `/prom/*` routes until `/suggest` exists; it leaves out only the matcher under the caret, copies kept matchers' source text and decodes the edited label name. LogQL v1 (#66): `lang/logql/lexer.ts`, one context-free scanner (`scanAt`) driving a CodeMirror `StreamLanguage` (resumable per line) and the whole-text lexer of the caret context, with a mode stack (selector, parens, grouping, range; at most 64 frames) |
| `dash-qctx` tolerant context parser | `lang/context.ts`: the `CaretContext` of §4.4 from the Lezer tree (PromQL) or from the tokenizer with the bracket and mode stack (LogQL, TraceQL); runs on the main thread (≤ 2 ms per keystroke, PRF-005). LogQL v1 (#66): `lang/logql/context.ts` with the contexts `labelName`, `labelValue`, `grouping`, `stage`, `function` and `duration`, the M-UI1 subset of §4.4's `CaretContext` (`LogField` waits for detected fields, M-UI2) |
| Validation in the `editor` worker | v1: on run (and on Explore's auto-run), the BFF forwards the query to PulsusDB and maps its error and position, if any, to a diagnostic. Later: `dash-editor.wasm` (PulsusDB crates) in an editor worker on every edit (§4.2 diagram), with no change to the editor |
| `promql-parser` `prettify()` for formatting | **Not in M-UI1.** Formatting ships with the WASM crates (M-UI2, §11). A PulsusDB format route through the BFF (Q5) MAY bring it earlier, only once PulsusDB confirms the route. T09-011 stands |
| `nucleo-matcher` fuzzy ranking | CodeMirror autocompletion's matcher plus the ranking boosts of §4.4 |
| `pulsus-re2` regex screen (T09-016) | T09-016 revised |
| Visual builder over the PulsusDB AST (§4.9) | Over the Lezer PromQL tree with a TS printer and a token-sequence loss check (§4.9 and T09-013 rewritten); no PulsusDB AST or printer is needed |
| Leptos `QueryEditor`, `QueryBuilder` | React components (§5.1) |
| Editor-worker suggest cache | Module-level LRU in the editor chunk, same keys and TTL (T09-007, T09-014). v1: `editor/suggestCache.ts`; key `(tenant, lang, kind, label, selector, bucket)` without `scope_fp` while data scopes are deferred (D12); TTL from settle; LRU by last get; eviction never aborts; an in-flight entry is tracked by key apart from the LRU, so an evicted one is re-joined by its key; a tenant switch or clear ends a generation, aborting every tracked call (metadata included) and rejecting its callers at once; a source with an ended token sends nothing; metadata is one TanStack query per tenant. #66: `lang` is `promql` or `logql`. #107: no entry is superseded by another key in any language: an in-flight entry aborts when its last signalled caller releases it and no unsignalled caller holds it, or when its generation ends |

## 1. Context & problem

Most users never type a query ([13](../product/13-core-flow-storyboard.md): "zero queries typed").
The ones who do are experts, and they compare us with the query explorers of incumbent tools, which run full JS code
editors with language servers. Since [ADR-0014](../adr/0014-typescript-react-web-client.md) we build
on CodeMirror 6, and the editor must be as good for queries of a few hundred bytes up to 128 KB.

That means:
- highlighting;
- error positions: PulsusDB's on run (SRF-027), exact before run from the browser parser (SRF-078);
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
- A PromQL visual builder at M-UI1 that round-trips with the text, built on the Lezer PromQL tree (§4.9).

**Non-goals**
- A general code editor (multi-cursor, minimap, folding, Vim mode). Vim mode is a candidate later.
- SQL or other datasources (PRN-012: PulsusDB, plus Prometheus-API read-only sources later).
- Evaluating queries in the browser. That is T13 (draft) for local data, the BFF for virtual sources
  ([T07](T07-scene-query-planner.md) §4.11), and PulsusDB otherwise.

## 3. Satisfies

| Requirement | Satisfied by (§) | Verification (T05 gate) |
|---|---|---|
| [SRF-027](../product/04-surfaces.md#srf-027--promql-editor) | §4.2, §4.3, §4.4, §4.5, T09-002, T09-009 | `e2e:editor-error-on-run`: running `rate(http_server_duration_bucket{service="checkout"[5m])` against `pulsus-fake` shows PulsusDB's parse error inline, underlined at the returned position or across the whole query when none is returned, and keeps the previous result; `itest:editor-completion-metadata` (metric, label and value completion from seeded PulsusDB metadata); `unit:hover-docs-functions` |
| [SRF-078](../product/04-surfaces.md#srf-078--positioned-query-diagnostics-before-run) | §4.2 (WASM validator), §4.5, T09-009 | `e2e:editor-missing-brace`: typing `rate(http_server_duration_bucket{service="checkout"[5m])` underlines the missing `}` at its byte offset before run, with no request sent |
| [SRF-028](../product/04-surfaces.md#srf-028--query-explain) | §4.5 (explain: structure + `X-Pulsus-Explain`) | `itest:explain-matches-headers` (T07 co-owns): rollup, rows read and server time match the PulsusDB response for a seeded 7-day query |
| [SRF-029](../product/04-surfaces.md#srf-029--visual-query-builder) | §4.9, T09-013 | `prop:builder-roundtrip`: for every query in the PromQL corpus the builder can represent, text → builder → text has the same non-whitespace Lezer token sequence and builder → text → builder is identical; every other corpus query (including reject cases and queries with `#` comments) yields a named refusal and leaves the text unchanged; `e2e:builder-toggle-invalid`: toggling `rate(http_server_duration_bucket{service="checkout"[5m])` names the syntax error and stays on text |
| [SRF-030](../product/04-surfaces.md#srf-030--metrics-auto-vis-and-multiple-queries) | §4.6 (`VisHint`), §5.1 (multiple editors, A/B refs) | `e2e:metrics-autovis`: a histogram metric shows a heatmap; queries A, B and `A / B` show overlaid or as small multiples (T07 co-owns expression evaluation) |
| [SRF-031](../product/04-surfaces.md#srf-031--metric-browser-and-series-table) | §4.4 (metric browser source: names, type, cardinality, label value counts) | `itest:suggest-metric-browser`: `http_` lists matching metrics with type and series count; labels for the selection list value counts |
| [SRF-032](../product/04-surfaces.md#srf-032--cardinality-explorer) | §4.4 (`kind: cardinality`) | `itest:suggest-cardinality`: a seeded metric with 3.2k series, 2.9k from `pod`, returns `pod` as the largest entry with its count |
| [INT-038](../product/03-interaction-model.md#int-038--query-detection) | §5.1 (`QueryLanguage::detect`) | `unit:lang-detect`: `rate(`, `{app=`, `{ span.`, `process_cpu:` each score highest for PromQL, LogQL, TraceQL, profile selector; `e2e:palette-query-detect` (T08 co-owns) |
| [VIZ-065](../product/05-visualisation-catalogue.md#viz-065--auto-vis-rules) | §4.6 (hint follows Table 5-13 order) | `unit:plan-parity` (the rewrite and hint rows decidable from the query and metric types; #112) and `unit:autovis-table` (the rows confirmed on result shape); T07/T02 confirm the remaining rows |
| [PRF-005](../product/09-performance-contract.md#prf-005--no-main-thread-long-tasks-during-interaction) | §4.2 (main-thread work bounded), §7 | `bench:editor-keystroke`: ≤ 2 ms main-thread work per keystroke on a 1 KB query; 0 long tasks during typing scripts |
| [PRF-009](../product/09-performance-contract.md#prf-009--core-bundle-size-and-lazy-loading) | §4.3 (lazy editor chunk), §0 | `ci:bundle-size`: editor chunk ≤ 175 KB and absent from initial JS; `e2e:lazy-load`: a cold load that opens no editor fetches no editor chunk |
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

#### T09-001 — PulsusDB parsers sit behind one interface
**MUST** — PulsusDB's parser, whether reached through the BFF or compiled to WASM, MUST be used only
through the `QueryLanguage` interface in `client/src/editor/lang/` (§5.1). Every other module
(editor, builder, ⌘K detection) MUST use the interface, so moving from the BFF to the WASM crates is a
module swap, not a redesign. Each language implements `QueryLanguage` in `lang/<lang>/`. No language
directory imports another (ESLint `no-restricted-imports`). Explore, the panel editor and board panels
MUST reach a language only through `LANGUAGES` and the interface.

### 4.2 Architecture: three layers, two threads

> **Note:** the diagram shows the WASM phase as designed in 1.0-rc. In v1 (§0) everything left of the
> worker is CodeMirror in the main thread (the textarea, `EditBuffer` and underlay are CodeMirror's
> `EditorState` and decorations), the context parser and completion run in the main thread, and
> validation is a BFF call on run instead of the worker.

```
 main thread (TS application)                                EDITOR worker: dash-editor.wasm (lazy)
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
`dash-qlex` and `dash-qctx` MAY drive colour, completion and spans, but MUST NOT place errors or mark
a query valid or invalid.

*Exception (#121):* before dispatch, the server MAY refuse a text it cannot classify safely. This
is a fail-closed security guard (T07-020, T06-029), not a validity decision. Today the only case is
a top-level `#` in LogQL, which PulsusDB also refuses: 400 `query.invalid` positioned at the `#`,
with the message `unexpected '#' at byte N: LogQL has no comments`. The editor shows it as it shows
any server error with a position (T09-009).

#### T09-003 — Highlighting never waits
**MUST** — Highlighting MUST run synchronously on the main thread from the CodeMirror language of
§0 (incremental Lezer parse for PromQL, resumable stream tokenizers for LogQL and TraceQL), within
≤ 2 ms per keystroke for a 1 KB query. It MUST NOT wait for the network or a worker.

### 4.3 Editor surface: CodeMirror 6 (decision, ADR-0014)

| Option | IME | Screen reader | Mobile keyboards | Decorations | Effort |
|---|---|---|---|---|---|
| A. Transparent `<textarea>` over a highlighted `<pre>` underlay (1.0-rc decision) | native | native | native | spans, squiggles; no inline widgets | low, but every editor feature is ours |
| **B. CodeMirror 6** (a mature `contenteditable` editor that reconciles composition per browser) | handled by the library, tested per browser | ARIA textbox, tested | supported | anything (widgets, gutters, tooltips) | low: completion, history, bracket matching, search and keymaps are provided |
| C. Canvas-text editor (GPU text) | must re-implement through a hidden input | must be re-implemented | poor | anything | very high |

**Decision: B**, as [ADR-0014](../adr/0014-typescript-react-web-client.md) §1 decides. With a JS
framework allowed, the reasons for A (no JS editor available, ADR-0002) are gone, and CodeMirror
supplies composition handling, accessibility, completion UI, history and bracket matching.

#### T09-004 — CodeMirror 6 surface
**MUST** — Query editing MUST use CodeMirror 6, loaded as part of the lazily loaded editor chunk with
the Explore and panel-editor routes (≤ 175 KB brotli, ADR-0014 §8). Editors MUST NOT use another
editor surface, a hand-built `contenteditable` or canvas text input.

Mechanics:
- **Document.** CodeMirror's `EditorState` is the buffer; edits arrive as transactions, so no diffing
  of the whole value is needed. Programmatic edits (completion accept, format, AI insert, builder sync)
  are dispatched as transactions with a `userEvent` annotation.
- **Size.** The editor auto-grows up to 12 lines, then scrolls. Font, size and line height come from
  the tokens (JetBrains Mono, VL-010).
- **Keys.** The editor is the 03 **Text input** context ([T08](T08-dom-component-kit.md) §4.8):
  `⌘⏎` runs, `⌘⇧F` formats, `Esc` leaves the field (closing an open completion popup first), `⌘Z`
  and `⌘⇧Z` undo and redo, and `⌘K` opens the palette. `Tab`/`Enter` accept a completion only while
  the popup is open; otherwise `Tab` moves focus (CodeMirror's tab-focus mode), so the editor is never
  a keyboard trap.
- **Highlighting** is a CodeMirror language per query language (§0): the Lezer PromQL grammar, and
  in-house stream tokenizers for LogQL and TraceQL. Ghost-text completion is not used.
- **Host (v1, #63).** The view mounts in an open shadow root, so CodeMirror's style modules are
  adopted stylesheets, which `style-src 'self'` allows (ADR-0014 §9). Window-key exclusions read the
  whole `composedPath()`, so keys typed in the editor do not step the window (INT-032).
- **v1 Explore keys (#63 Part C).** `Esc` with no popup open moves the focus to the page's **Run**
  button, so the editor never traps focus; Shift+Enter and Mod+Enter run from the editor.
- **v1 board panel editor (#64 Part A).** The panel editor's PromQL Query field is the same editor,
  with the metric picker and a **Run query** button: Shift+Enter, Mod+Enter and Run query run the
  text for the preview and the panel behind, and so does focus leaving the field with a text that
  has not run; typing changes only the board draft. `Esc` closes an open popup, else moves the
  focus to Run query, and does not reach the dialog: a second `Esc` closes the dialog.
- **Fallback when the editor chunk fails (#147).** If the editor chunk fails to load, every query
  field (Explore and the panel editor) shows a native `<textarea>` ([T08](T08-dom-component-kit.md)
  §4.8) with the load-failed alert. It runs on Run and on Shift/Mod+Enter, unchanged text included;
  it is a degraded fallback, not an editor surface. A language-only failure shows the alert, never
  the text area, so a later editor never replaces typed text. While a field's imports have failed
  its runs are degraded: without a loaded language a PromQL query goes to the range route
  ([ADR-0021](../adr/0021-query-planning-is-server-side.md): the server plans the text) and errors
  carry no editor diagnostics. The 128 KB limit (T09-015) still applies.
- **v1 composition guard (T09-005, #63).** An open or pending completion popup closes at
  `compositionstart`; while composing nothing opens, is looked up or is accepted, and results that
  arrive are held and dropped; completion re-evaluates once, 20 ms after the last `compositionend`.

#### T09-005 — Composition is respected
**MUST** — During composition (`compositionstart` → `compositionend`) the editor MUST keep
re-highlighting but MUST NOT open, accept or reorder completions and MUST NOT reformat. Completion
re-evaluates on `compositionend`.

#### T09-006 — One undo history
**MUST** — Typed and programmatic edits MUST share one undo history: both are CodeMirror
transactions recorded by its `history` extension, and `⌘Z`/`⌘⇧Z` undo and redo them in order.

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
  v1 over `/prom/*` (#63): names up to 10 000 (filtered locally), the rest up to 1 000; lookups ask
  for the window snapped to whole minutes (series: whole seconds). The 200-item limit and "type to
  narrow" come with `/suggest`.
- **Scope.** Families withheld by the principal's metrics scope (T07-015) are listed with "withheld
  by scope" and no series count.
- **LogQL v1 (#66).** Label names and values come from the BFF's `/logs/labels` and
  `/logs/label/{name}/values` with `query` = the other complete matchers of the caret's selector as
  written (never `{}`; a matcher whose value holds a variable reference is left out, T09-010; a
  grouping lookup uses the first selector), the window snapped to whole minutes, and limit 1 000.
  Accepting an option replaces the whole token or value under the caret, re-measured at accept
  time, and never a delimiter: a quoted value that is not well closed ends at the first quote, `}`,
  `,` or whitespace after the caret and gains its closing quote.
- **PromQL v1 (#107).** The list filters by the text before the caret. Accepting replaces the whole
  token or value under the caret, re-measured at accept time: the package's own end rule, and a
  label value that is not well closed ends at the first unescaped quote, `}`, `,` or whitespace
  after the caret and gains its closing quote. Static items are listed above lookup results in one
  list, and the local slot holds a result whenever the remote one can, so a late result never moves
  the highlighted item (T09-008).

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

v1 (#66, LogQL; #107, PromQL): static completions answer from a local source with no typing delay
(≤ 16 ms, §7): LogQL's stages, functions and durations; PromQL's functions, aggregations, keywords,
operators, durations and numbers. Remote lookups wait 120 ms inside their own source and restart on
every document change, so a lookup starts 120 ms after the last keystroke; PromQL's remote source
answers metric names, label names and label values. In LogQL, a view's interest in an in-flight
lookup is released when its caret context leaves the lookup's key (another key, a non-remote
context, or the view's end); in PromQL, every document or selection change releases it (the next
lookup starts 120 ms after the last key). Another view's interest keeps a shared request: the
shared fetch aborts when its last signalled caller releases it.

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

#### T09-009 — Error positions are byte offsets, or the whole query
**MUST** — *(Revised 1.3-rc.)* Each PulsusDB parser error MUST be underlined at the byte offset the
parser gives: the structured span for LogQL and TraceQL; for PromQL, the position in the message. An
error that comes with no position MUST be underlined across the whole query and labelled "position
unknown"; no other placement (such as a guessed recovery point) is allowed. The same rule applies to
errors from PulsusDB through the BFF on run (SRF-027) and to the WASM validator before run (SRF-078).
*(2026-11-21, #65.)* LogQL positions: PulsusDB's LogQL errors are text that reads `at byte N`, with
`N` a 0-based byte offset; the BFF reads `N` as the offset, kept only within the text.

*Note (ADR-0021, 2026-11-21):* on run, the position arrives already mapped to the raw text; the
client uses `toSource = identity`.

**Board variables and macros** (`$var`, `${var}`, `$__rate_interval`, `$__interval`) are not PulsusDB
syntax.

#### T09-010 — Variables are substituted with an offset map
**MUST** — *(Revised 1.7-rc, ADR-0021.)* Before execution, the language module's `Plan` (server)
substitutes each variable and macro and maps PulsusDB's error position back into the raw text:
inside an inserted value, to the reference's start; inside a rewrite prefix or suffix, to no
position. Before validation in the browser (the WASM phase), `lang/context.ts` substitutes
type-correct placeholders with its own offset map. The browser never substitutes the text it sends.

- **Hover docs.**
  - **Functions and keywords:** from `dash-qdocs`, written by us. Prometheus docs (Apache-2.0) are
    adapted with attribution. Third-party LogQL and TraceQL documentation is AGPL-licensed; under D3 it MAY be
    adapted with attribution and licence notice, but our own text is preferred so the three languages read
    consistently.
  - **Metrics:** type, unit, help and series count (from `/api/v1/metadata` and BFF cardinality).
  - **Label values:** series or stream count.
  - **Durations:** the resolved value and its relation to the current step ("5m = 20 × step").
  - **`$__rate_interval`:** its resolved value.
  - **Reserved virtual selectors:** "served by Dash from alert history (Postgres)", with the
    supported subset.
- **Format / prettify** (`⌘⇧F`, and on save in alert rules). *Ships with the WASM crates (M-UI2,
  §11), or earlier only through a PulsusDB format route once confirmed (Q5). Until then no format
  command is offered and `⌘⇧F` does nothing in the editor.*
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

The **Rate applied** chip and auto-vis rules 5 and 6 read the server's `planned` facts
([ADR-0021](../adr/0021-query-planning-is-server-side.md)). The Lezer `shape` gives the pre-run hint
and the route choice.

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

**v1 (#63, planned on the server by #112).** The server plans the query (ADR-0021): the Explore
metrics page sends the text as typed with the rate chip (`rate`) and, for an instant query, the
step; the BFF's `prom.Plan` sends a bare counter selector as `rate(<sel>[w])` and a bare histogram
bucket selector as `sum by (le) (rate(<sel>[w]))` behind the chip (rows 6 and 5), with the rate
window `w = max(4 × step, step + S, 4 × S)`: `S` is the scrape interval, 15 s by default until a
per-binding value exists, so a window always holds at least four scrapes. Whether a name is a
counter or a histogram comes from the server's per-binding metric types. With the chip off the
selector is sent as written and drawn as a line. The page reads every fact from the response's
`planned`: the chip shows when `rate_candidate`, rule 6 and the `/s` unit apply when `rate_applied`,
rule 5 may apply when `histogram`, and "Sent query" shows `planned.query`. A scalar- or
string-typed query (the Lezer shape on the main thread; there is no editor worker yet) is sent as
an instant query. The result confirms the hint: rows 5, 6, 7 and 14 apply in that order
(`client/src/vis/autovis.ts`), and row 7 applies only to a scalar or an instant result of one series
with one point. The server refuses a planned text over 64 KiB (413), and a position arrives mapped
to the editor text (T09-009).

**v1 (#66).** Explore › Logs sends the text as typed to the range and volume routes. Row 4 shows the
volume and the stream (patterns arrive with SRF-034, M-UI2). Row 14 for LogQL draws every metric
query as a line in M-UI1; bars for `count_over_time` follow.

**Boards (#67).** Auto: stream for a log query, line for a metric query; Bars: volume by level. The
answer's kind decides.

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

- `HighlightRuns` = `(start, len, TokenClass)[]` per line, produced from the CodeMirror syntax tree
  and applied as CodeMirror decorations, so only changed lines re-render.
- `TokenClass` maps to syntax tokens in `dash-tokens` (`--syn-metric`, `--syn-label`, `--syn-string`,
  `--syn-number`, `--syn-duration`, `--syn-func`, `--syn-keyword`, `--syn-op`, `--syn-error`,
  `--syn-var`, `--syn-virtual`), designed for dark, light and high-contrast themes
  ([T08](T08-dom-component-kit.md) §4.7). Query text uses JetBrains Mono (VL-010).
- **v1 tokens (#63):** `syn-keyword`, `syn-func`, `syn-string`, `syn-number` (durations too),
  `syn-label`; metric names use `text`, operators and comments `text-muted`.
- **Bracket matching:** the bracket pair at the caret, plus mismatched-bracket marks. **Occurrence
  highlighting:** the same label name everywhere in the query.
- **Read-only snippets** (Inspector, ⌘K results, AI dock, Investigation evidence) use the same lexer
  in a read-only CodeMirror view or as styled spans.
- **Canvas labels** that show queries pass `HighlightRuns` to GPU text as per-glyph colour
  ([T02](T02-vis-engine.md)).

### 4.9 Visual query builder (PromQL at M-UI1)

SRF-029 requires a builder (metric → filters → operations) as a toggle that round-trips with the text
without loss for any query it can represent. *(Rewritten 1.4-rc for M-UI1: the builder runs in the
browser on the Lezer PromQL tree; it needs neither PulsusDB's AST nor its printer.)*

- **Model.** `BuilderModel` is a projection of the Lezer PromQL tree: `metric` (with type and unit
  from metadata), `filters: Matcher[]` in written order (label pickers backed by `/suggest`), and an
  ordered `ops: Op[]` pipeline, where `Op` ∈ range function (`rate`, `increase`, `*_over_time` with
  a duration), aggregation (`sum`/`avg`/`min`/`max`/`count`/`topk`/`bottomk` with `by`/`without`),
  `histogram_quantile(φ)`, scalar arithmetic and comparison with a constant, and binary operation
  with another builder query (`A / B`, with `on`/`ignoring`). The model also keeps each written
  form the printer needs to reproduce the text: duration and number literals as written, the quote
  character of each string, and whether a grouping clause precedes or follows the aggregation body.
- **Text → builder.** `project(tree, text) → BuilderModel | Refusal` walks the Lezer tree from the
  outermost node inwards. It refuses, with a named reason shown by the toggle, when:
  - the tree contains an error node: "fix the syntax error at offset n first" (the text stays in the
    editor; the builder never repairs text);
  - the text contains a `#` comment: "comments cannot be shown in the builder";
  - a construct is outside the model, e.g. "subquery", "nested binary operation with vector
    matching on both sides", "`label_replace`", "offset/@ modifiers inside an aggregation".
- **Builder → text.** `print(model) → string` is a TS printer over the model, emitting the written
  forms kept above with single spaces between tokens. The editor is updated with one CodeMirror
  transaction, so it is one undoable edit. A model without a metric prints an empty query.
- **Loss check.** Before switching to the builder, the toggle checks that `print(project(q))` has
  the **same sequence of non-whitespace Lezer tokens** as `q`. Equal tokens mean the texts differ only
  in whitespace between tokens, which PromQL ignores (comments, the one whitespace-sensitive case,
  are refused above). On a mismatch the toggle stays on text and names the first differing token.
- **Validity.** The builder never decides validity (T09-002). Text it prints is validated like any
  other text: by PulsusDB on run in M-UI1 (SRF-027), and by the WASM crates before run from M-UI2
  (SRF-078). Lezer accepting a query PulsusDB rejects is caught by T09-017.
- **Accessibility.** The builder is kit form controls (comboboxes, lists with reorder buttons), fully
  keyboard-operable ([T08](T08-dom-component-kit.md)).
- LogQL and TraceQL builders follow at M-UI5 on the same pattern.

#### T09-013 — Builder round-trips or explains
**MUST** — *(Revised 1.4-rc.)* Toggling from text to the builder MUST either produce a model whose
printed text has the same sequence of non-whitespace Lezer tokens as the original, or refuse with a
named reason (syntax error, comment, unrepresentable construct, or token mismatch) and leave the text
unchanged. Toggling from the builder to text and back MUST restore an identical builder state.

## 5. Interfaces

### 5.1 Defined here

```ts
// client/src/editor/lang/types.ts (type-only imports; no run-time imports)
import type { Extension } from '@codemirror/state';
export type LangId = 'promql' | 'logql' | 'traceql' | 'profile';
export interface QueryLanguage {
  readonly lang: LangId;
  /** Highlighting (T09-003) and completion over this language's upstream lookups (T09-007, T09-014). */
  editor(deps: LanguageDeps): readonly Extension[];
  shape(text: string): QueryShape;                                   // auto-vis input (§4.6)
  diagnosticsOf(text: string, error: unknown,
    toSource: (sentIndex: number) => number | null, sent: string): Diagnostic[]; // T09-009
  detect(prefix: string): number;                                    // ⌘K detection (INT-038)
}
/** The BFF client and the tenant/scope key of the suggest cache (T09-014). */
export interface LanguageDeps { /* fields fixed by the implementing issue */ }
// client/src/editor/lang/index.ts: a static table, not a registry
export const LANGUAGES: Readonly<Record<LangId, () => Promise<QueryLanguage>>>;
```

v1 (#63): `LanguageDeps` is `{api, queryClient, tenant, window, cache?}` (the BFF client, the
TanStack client, the tenant, the window shown now, and the suggest cache). A language's `editor(deps)`
returns its language, highlight and completion source (as `autocomplete` language data, run by the
host's completion guard). PromQL lives in `lang/promql/`; `LANGUAGES` resolves PromQL and rejects the
three languages not built yet. `detect` returns 0 until ⌘K detection (INT-038) is built.
`PromQLEditor` is the PromQL-only M-UI1 `QueryEditor`.

v1 (#66): `lang/logql/` is the second language. Its `shape` returns `UNKNOWN_SHAPE` for every text:
LogQL has one range route, so no route choice needs a shape, and log versus metric is the response's
`kind` ([ADR-0021](../adr/0021-query-planning-is-server-side.md) §4). `QueryEditorHost` is the host
of both languages; `PromQLEditor` and `LogQLEditor` wrap it.

Auto-vis (SRF-030, VIZ-065, §4.6) ships in M-UI1 through `shape`: the language returns a
`QueryShape`, and the Explore planner applies the Table 5-13 rows to that shape, the metric metadata
and the result (#63). Only the interface methods are later. `validate` and `format` are added with
the WASM parser crates in M-UI2 (SRF-078, T09-011). `visHint`, which derives the hint in the editor
worker before results arrive, is added with that worker in M-UI2. Until then the `shape` path
delivers the hint. There is no second interface.

| Interface | Consumers |
|---|---|
| `QueryEditor` React component (`lang`, `value`, `onChange`, `onRun`, `readOnly`, `vars: VarScope`, `refName?: string` for A/B/…) | T08 rooms, workbenches (multiple editors A, B, … and expression editors, SRF-030), alert-rule room (T16), Board editor |
| `QueryBuilder` React component (`model: BuilderModel`, `onChange`, bound to a `QueryEditor`) | Metrics workbench (M-UI1) |
| `highlight(lang, &str) -> HighlightRuns` (sync, main thread) | T08 (snippets, ⌘K), T02 (canvas labels) |
| `LangMsg`/`LangReply` (application ⇄ editor worker, from the WASM phase; structured clone): `Edit{doc, version, edits}`, `Complete{doc, version, caret}`, `Hover{doc, offset}`, `Format{doc}`, `Explain{doc}`, `Project{doc}`, `Print{model}` → `Diagnostics`, `Completions`, `HoverCard`, `Formatted`, `VisHint`, `Builder`, `Text` | internal; worker topology from T03 |
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
| [T03](T03-browser-runtime.md) | From the WASM phase: the `dash-editor.wasm` satellite in its own `editor` worker, loaded on first focus of a query bar, with a message channel to the application. Highlighting stays TS in the editor chunk (§0) |
| [T06](T06-bff-architecture.md) | Implements `/suggest`, with its metadata cache, cancellation and scope rewriting. `X-Pulsus-Explain` passthrough on run |
| [T07](T07-scene-query-planner.md) | Virtual-source subset and join limits (§4.11) for the *virtual unsupported* diagnostics; plan explain view |
| [T12](T12-entity-catalogue.md) | A local catalogue index exposing entity identity values per label/attribute name, and the label ⇄ attribute map |
| T15 (draft) | `POST /api/dash/v1/ai/query/{explain,generate}`, which returns spans or text and records an audit entry |
| [T08](T08-dom-component-kit.md) | Editor theme tokens, the dock host, the undo key routing, the keymap context `TextInput(QueryEditor)`, and kit form controls for the builder |

## 6. Data & storage

| Data | Where |
|---|---|
| Query text | The owning object: Board viewport and alert rule in Postgres ([T11](T11-postgres-schema.md)), workbench state in the URL/Context |
| Query history (last 500 per language per user) | IndexedDB, plus optional server sync in user prefs |
| Suggest cache | editor-worker memory (LRU 2k keys) + BFF L1 |
| Function docs, grammar tables | Bundled in the lazily loaded editor chunk |

## 7. Performance budget

| Metric | Target | Notes |
|---|---|---|
| Keystroke → highlighted repaint | ≤ 1 frame; ≤ 2 ms main-thread work for a 1 KB query: the editor's update (incremental parse, highlighting, DOM sync), timed per key by `bench:editor-keystroke` (#63) | incremental CodeMirror parse (PRF-005) |
| Keystroke → diagnostics visible | ≤ 50 ms after a 30 ms idle, once the WASM crates land; until then on run | PromQL parse estimated ≤ 0.4 ms in wasm |
| Local completions | ≤ 16 ms from keystroke | their work per key (analysis, result, popup) is measured together with the key's document update by `bench:promql-completion-latency` `keyWork`, ≤ 2 ms (#107); remote processing is bounded per task (PRF-005) |
| Remote completions (cache miss) | ≤ 150 ms p50 / 400 ms p95 after the debounce | BFF L1 hit typical |
| Builder toggle (project + loss check) | ≤ 16 ms for a 1 KB query | editor worker |
| Editor-worker cold start (WASM phase: fetch + compile + LR init) | ≤ 300 ms on (b), overlapped with first focus | ~0.45–0.55 MB br estimated (PRF-009: not in core) |
| Editor chunk (CodeMirror + languages + components) | ≤ 175 KB br, lazy with the Explore and panel-editor routes; measured as `editor.ts`, `lang/promql/promql.ts` and the `editor-*` files statically reachable from them (the walk does not pass through other chunks; v1, #63) | [ADR-0014](../adr/0014-typescript-react-web-client.md) §8; not in the initial JS |
| Max query size | 128 KB (LogQL cap applied to all three) | T09-015 |

These are measured with Playwright typing scripts (per-keystroke frame timing) and a corpus replay of
10k real queries through the editor worker ([T05](T05-testing-and-performance.md)).

#### T09-015 — Query size cap
**MUST** — The editor MUST allow editing of any length but MUST pause validation and completion above
128 KB, with an explanation, and the run action MUST refuse a query above 128 KB (131 072 bytes) with
the same message. *(Revised 1.7-rc, ADR-0021.)* The BFF repeats this check and refuses a planned text
above 65 536 bytes (413). The client's check is a hint.

v1 (#63) measures UTF-8 bytes (`TextEncoder`) on every change: above 131 072 bytes the editor pauses
completion, and the page explains and refuses Run. Run is also refused, with its own message, when
the text to **send** (the rate rewrite included) is over the BFF's 64 KiB; the page plans the run only
once the metric metadata and the chart width are known, so the check uses the text that would be
sent (#63 Part C).

## 8. Security, tenancy & RBAC

- **Suggestions are data.** Label values can reveal customer names, hosts or tenants, so every remote
  suggestion is scope-rewritten in the BFF (T09-014).
- **AI calls** send query text and metadata only, under the T15 (draft) redaction policy. The audit
  log records generate and explain calls.
- **No query text in the URL for alert rules** (they are referenced by id). Workbench queries are in
  the URL by design ([02 §4](../product/02-information-architecture.md)), and share links obey the
  same RBAC.

#### T09-016 — Regex screening
**MUST** — Matcher regexes MUST be screened before run, and a regex that fails the screen MUST be a
diagnostic, not a run error. Until the WASM crates land, the screen is a TS check for the constructs
RE2 rejects (lookaround, backreferences, possessive quantifiers); with them, `pulsus-re2`'s compile
budget in the editor worker, the same bound PulsusDB applies.

## 9. Failure modes & degradation

| Failure | What the user sees |
|---|---|
| Editor worker fails to load | Highlighting still works (main thread). The status pip says "validation offline"; run still works and the server error is underlined per T09-009 |
| `/suggest` slow or down | Static and catalogue completions only, with the hint "live values unavailable" |
| PulsusDB parser gives no position (on run or before run) | The whole query is underlined, labelled "position unknown" (T09-009) |
| Client accepts but server rejects (version skew) | The server error is shown inline with "Dash and PulsusDB disagree: report" (telemetry counter). This is caught early by the parity CI below |
| Query over 128 KB | Editing is allowed. Validation and completion pause, with an explanation (T09-015) |
| Builder cannot represent the query | The toggle stays on text and names the construct (T09-013) |

## 10. Testing

#### T09-017 — Parity CI gates PulsusDB bumps
**MUST** — Every change of the pinned PulsusDB revision, and every update of the Lezer PromQL grammar,
MUST run the three upstream corpora (§4.1) through the checks that apply at that milestone, and MUST
fail on any mismatch. The same job pins the PulsusDB git revision Dash builds against.

| Check | From |
|---|---|
| Highlighters: token boundaries equal PulsusDB's | M-UI1 |
| Context parser: never throws, recovers on every reject case | M-UI1 |
| Lezer PromQL tree: accepts exactly what PulsusDB accepts | M-UI1 |
| Builder round-trip and refusals (T09-013) | M-UI1 |
| Formatter (T09-011) | When formatting ships: M-UI2 with the WASM crates, or earlier with a confirmed PulsusDB format route (Q5) |
| WASM validator: errors and positions equal PulsusDB's (T09-009, SRF-078) | M-UI2 |

- **Fuzzing** (`fast-check` property tests in Vitest) of the tokenizers and the context parser for
  exceptions and for incremental == full re-tokenise (`fuzz:qlex`, `fuzz:qctx`).
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
| M-UI1 | PromQL: CodeMirror 6 editor, Lezer PromQL highlighting and context, PulsusDB validation through the BFF on run (SRF-027), metric/label/value completion via `/suggest`, metric browser and cardinality kinds, hover for functions and metrics, `VisHint`, explain (structure + `X-Pulsus-Explain`), **visual builder**, multiple editors A/B with expressions; ⌘K detection for PromQL; **LogQL validation (PulsusDB parser) and label/value completion** for LogQL panels (#49) |
| M-UI2 | WASM validator (`dash-editor.wasm`, PulsusDB crates) for pre-run positioned diagnostics (SRF-078, [12](../product/12-roadmap.md) D11) and formatting (`⌘⇧F`, T09-011); TraceQL (incl. tags), LogQL detected fields, profile selectors, ⌘K detection for LogQL, TraceQL and profiles, history |
| M-UI4 | Alert-rule editor integration (quick-fixes, variables), AI explain/generate, virtual-source completion and diagnostics |
| M-UI5 | LogQL/TraceQL builders, Board variables UI |

**Build features.** When the WASM validator lands, the PulsusDB crates are linked into
`dash-editor.wasm` by default. A permissive fallback (upstream crates.io `promql-parser`; LogQL and
TraceQL validation through the BFF, as in v1) is **optional**: it is not part of CI and is only
revived if a non-AGPL edition is planned (D3, R17).

## 12. Alternatives considered

| Option | Why not |
|---|---|
| Hand-built textarea overlay (1.0-rc decision) | Every editor feature (completion UI, history, bracket matching, tooltips) would be ours; CodeMirror 6 provides them and handles composition per browser (§4.3, ADR-0014) |
| A hand-built `contenteditable` bridge | Cross-browser composition reconciliation is the hardest part of a code editor; CodeMirror already does it |
| Canvas-text editor | Would re-implement IME, selection, a11y and mobile input |
| Use PulsusDB parsers for highlighting too | Lexers are private or doc-hidden and not resumable; PromQL costs 115 µs or more per parse. Fine for validation, wrong for per-keystroke colour |
| Tree-sitter grammars (compiled to wasm) | Excellent incremental parsing, but it is a second grammar to keep at parity, a C toolchain in the build, and the community grammars for these languages lag. `dash-qctx` is smaller and tested against PulsusDB corpora |
| Server-side language server over WS | Every keystroke would wait on the network (PRF-006) |
| `ropey` rope | Unnecessary below the 128 KB cap |
| Clean-room LogQL/TraceQL parsers plus upstream `promql-parser` (draft licence option 2) | No longer needed under D3; about 3–4 engineer-months plus a permanent parity burden |
| Builder with its own grammar | A third grammar to keep at parity; projecting the Lezer tree the editor already has (held to PulsusDB by T09-017) makes round-trip loss checkable by token comparison |

## 13. Open questions

| # | Question | Leaning |
|---|---|---|
| Q1 | Will PulsusDB expose resumable public lexers and AST spans for LogQL/TraceQL (R17 nice-to-haves)? | Nice to have. `dash-qlex`/`dash-qctx` don't depend on it |
| Q2 | Comment-preserving PromQL formatting | Re-attach `#` comments by token position in our own printer (M-UI4), or refuse as now |
| Q3 | Should `/suggest` responses be Arrow for very large value sets? | No: ≤ 200 items as JSON is fine (config-like, [ADR-0005](../adr/0005-arrow-wire-format.md)) |
| Q4 | Builder coverage for binary operations with vector matching on both sides | Unrepresentable in v1; revisit with usage data |
| Q5 | Does PulsusDB offer a parse-only route (PromQL-compatible `parse_query`/`format_query`), so the BFF can validate on idle before run? | If yes, the BFF validate route can give pre-run positions before the WASM crates (SRF-078 earlier) and a format route can bring formatting forward; if no, validation is on run (SRF-027) and formatting waits for the crates (M-UI2) |

## 14. Change log

| Version | Date | Change |
|---|---|---|
| 1.0-rc | 2026-11-18 | Promoted from plans/ draft. Restructured to the template; rules T09-001…T09-017. **D3:** the AGPL PulsusDB parser crates are linked by default; the licence analysis and Q8/Q1 are closed; `QueryLanguage` kept (T09-001); the permissive fallback build is optional and leaves CI; R17 is a P3 nice-to-have. **SRF-029:** the PromQL visual builder moves from M-UI5 to M-UI1 (§4.9). Added `cardinality`/metric-browser `/suggest` kinds (SRF-031, SRF-032), virtual-source completion and *virtual unsupported* diagnostics (ADR-0012), Table 5-13 row numbers on `VisHint` (VIZ-065), scope-keyed suggest cache. AI explain moved off the `.` key (a Space-context binding in 03) to the ✦ button and a ⌘K action. Draft Q4 (04 wording on positioned errors) closed: SRF-027's note now matches |
| 1.0-rc | 2026-11-19 | Roadmap D5 ([12](../product/12-roadmap.md#21-delivery-order-2026-11-19) §2.1): §11 LogQL validation and label completion move M-UI2 → M-UI1; TraceQL, profile selectors, detected fields, ⌘K detection and history stay M-UI2 |
| 1.1-rc | 2026-11-19 | [ADR-0014](../adr/0014-typescript-react-web-client.md), [ADR-0015](../adr/0015-go-bff.md): new §0; the editor is CodeMirror 6 in TS (§4.3 and T09-004 rewritten); PulsusDB validation through the BFF on run until the WASM crates land; T09-001 (one TS interface), T09-003 (CodeMirror highlighting), T09-006 (CodeMirror history), T09-016 (regex screen) and T09-017 (parity incl. the Lezer PromQL grammar) revised; SRF-027 and PRF-009 rows; Q5 parse-only route |
| 1.2-rc | 2026-11-19 | Code review of #56: SRF-027 is errors on run from PulsusDB (`e2e:editor-error-on-run`); new SRF-078 row for pre-run byte-offset diagnostics (`e2e:editor-missing-brace`) with the WASM validator in M-UI2 (proposed); T09-009, §11 and Q5 aligned |
| 1.3-rc | 2026-11-19 | Code review r2 of #56: T09-009 has one fallback for every error without a position (whole-query underline, "position unknown"; no recovery-point placement), aligned in T09-002 and the §9 failure table; formatting moves out of M-UI1 to the WASM crates in M-UI2, optionally earlier through a confirmed PulsusDB format route (§0, §4.5, §11, Q5) |
| 1.4-rc | 2026-11-19 | Code review r3 of #56: §4.9 and T09-013 rewritten for the M-UI1 builder on the Lezer PromQL tree (TS printer keeping written forms, token-sequence loss check, named refusals for syntax errors, comments and unrepresentable constructs; validity stays with PulsusDB); §0 row and SRF-029 test updated; product names removed from hover-docs guidance and the alternatives table |
| 1.5-rc | 2026-11-19 | Code review r4 of #56: T09-017 phased by milestone; the formatter check starts when formatting ships (M-UI2 or a confirmed format route) and the WASM validator check in M-UI2; the M-UI1 checks are unchanged; review r8: milestone line separates the M-UI1 LogQL slice (validation on run, label/value completion) from M-UI2 |
| 1.6-rc | 2026-11-21 | [ADR-0018](../adr/0018-query-language-modules.md): §5.1 QueryLanguage covers highlighting, completion and lookups; static LANGUAGES table; auto-vis stays M-UI1 through `shape`, and only the `validate`, `format` and `visHint` methods are added in M-UI2; T09-001 isolation sentence |
| 1.7-rc | 2026-11-21 | [ADR-0021](../adr/0021-query-planning-is-server-side.md): §0 the BFF parses PromQL only to plan it; T09-009 note (positions arrive mapped to the raw text); T09-010 revised (the server's `Plan` substitutes and maps positions; the browser substitutes placeholders only for WASM validation); §4.6 rate chip and rules 5 and 6 read the server's `planned` facts; T09-015 revised (the BFF repeats the 128 KB check and refuses a planned text above 65 536 bytes) |
| 1.8-rc | 2026-11-21 | #63 Part A: §4.6 adds "v1 (#63)": the hint on the main thread from the Lezer tree and metadata, the rate-chip rewrites of bare counters and histograms, instant queries for scalar and string types, and the size limit on the sent text; the VIZ-065 Satisfies row names `unit:explore-plan` and `unit:autovis-table` (T05 §7.1) instead of `unit:vishint-table-5-13`, which T05 does not define |
| 1.9-rc | 2026-11-21 | #63 Part A: §4.6 rate window of the rate-chip rewrites is `max(4 × step, step + S, 4 × S)` with `S` the scrape interval (default 15 s, per binding later), replacing `4 × step`, which held too few samples at small steps |
| 1.10-rc | 2026-11-21 | #63 Part B: §0 rows `dash-qlex` (PromQL v1 language and completion over `/prom/*`) and "Editor-worker suggest cache" (v1 key, TTL from settle, LRU, per-kind supersede, tenant generations); §4.3 v1 host (shadow root, composed-path window keys) and composition guard; §4.4 v1 limits and lookup windows; §4.8 v1 syntax tokens; §5.1 v1 `LanguageDeps` fields, `lang/promql/`, `LANGUAGES`, `detect` until INT-038, `PromQLEditor`; T09-015 v1 measurement |
| 1.11-rc | 2026-11-21 | #63 Part C: §4.3 v1 Explore keys (`Esc` moves the focus to Run); §7 Editor chunk row measures the editor entries and the `editor-*` files they statically reach; T09-015 v1: Run is also refused above the BFF's 64 KiB on the sent text, planned only with the definitive inputs |
| 1.12-rc | 2026-11-21 | #63 Part C plan 7: §7 "Keystroke → highlighted repaint" row: the 2 ms is the editor's update (parse, highlighting, DOM sync), timed per key by `bench:editor-keystroke` |
| 1.13-rc | 2026-11-21 | #112: the VIZ-065 Satisfies row names `unit:plan-parity`, which replaces `unit:explore-plan` (T05 §7.1) |
| 1.14-rc | 2026-11-22 | #112: §4.6 "v1" paragraph: the server plans the rate-chip rewrites and checks the sent size (ADR-0021); the page sends the raw text and reads the chip, rules 5 and 6 and the sent query from `planned`; `client/src/explore/plan.ts` is gone |
| 1.15-rc | 2026-11-22 | #65 Part A: T09-009 reads LogQL's `at byte N` (0-based) as the offset |
| 1.16-rc | 2026-11-22 | #64 Part A: §4.3 (T09-004) v1 board panel editor: the same editor and Run keys, Run query, a run when focus leaves the field, and `Esc` to Run query, then to close the dialog |
| 1.17-rc | 2026-11-23 | #121: T09-002: the server's fail-closed pre-dispatch refusal (LogQL top-level `#`) is not a validity decision |
| 1.18-rc | 2026-11-23 | #66 Part A: §0 rows `dash-qlex` (the LogQL scanner and `StreamLanguage`, the mode stack), `dash-qctx` (the v1 LogQL contexts) and "Editor-worker suggest cache" (the key by language; PromQL supersession, LogQL release by caller interest); §4.4 LogQL v1 lookups (scope as written, variable references left out, minute window, limit 1 000) and whole-token replacement; T09-007 v1 note (the synchronous local slot and the 120 ms remote slot; release when the caret context leaves the key); §5.1 v1 LogQL `shape` and the shared host |
| 1.19-rc | 2026-11-23 | #107: §0 "Editor-worker suggest cache": an in-flight entry is tracked by key apart from the LRU and re-joined by its key; no entry is superseded by another key in any language; §4.4 PromQL v1 (filtering by the text before the caret, whole-token replacement, static items above lookup results, T09-008); T09-007 v1 note (PromQL's local and remote slots; every document or selection change releases the PromQL view's interest; another view's interest keeps a shared request); §7 "Local completions" row: `keyWork` measures the work per key with its document update (≤ 2 ms); remote processing bounded per task |
| 1.20-rc | 2026-11-23 | #66 Part C: §4.6 adds "v1 (#66)": Explore › Logs sends the text as typed to the range and volume routes; row 4 shows the volume and the stream (patterns with SRF-034, M-UI2); row 14 for LogQL draws every metric query as a line in M-UI1, bars for `count_over_time` later |
| 1.21-rc | 2026-11-24 | #67: §4.6 adds "Boards (#67)": a board LogQL panel's Auto draws the stream for a log query and a line for a metric query, Bars the volume by level; the answer's kind decides |
| 1.22-rc | 2026-11-24 | #147: §4.3 (T09-004) note: when the editor chunk fails, every query field is a native text area that runs on Run and the Run keys; a language-only failure shows the alert only; while a field's imports have failed its runs are degraded (PromQL without a language goes to the range route); T09-015 still applies |
