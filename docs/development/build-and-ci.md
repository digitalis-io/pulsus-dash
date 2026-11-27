# Build, test and CI

How to build and check the web client and the server locally, and what CI runs. The client is
TypeScript, React and Vite in `client/` ([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md)).
The server is Go in `server/` ([ADR-0015](../../designs/adr/0015-go-bff.md)); see
[Server](#server). The Rust chart engine is in `engine/`; see [Engine](#engine). The gate IDs are those of the
[T05 §7.1 gate catalogue](../../designs/technical/T05-testing-and-performance.md).

## Toolchain

| Tool | Version | Where it is fixed |
|---|---|---|
| Node.js | 24.22.3 | `client/.nvmrc`; `package.json` `engines` is `>=24.22.3 <25` and `.npmrc` sets `engine-strict=true` |
| npm | the one bundled with Node 24 | — |
| Every npm package | exact versions | `client/package.json`, `client/package-lock.json` (lockfile v3) |
| Browsers for end-to-end tests | the builds of the pinned `@playwright/test` | `npx --no-install playwright install --with-deps <browser>` |

All commands below run in `client/`. Install with `npm ci` (never `npm install` for a check run;
see [the supply chain page](../client/supply-chain.md) for adding a dependency).

## npm scripts

| Script | What it does | Gate |
|---|---|---|
| `npm run dev` | Vite dev server on `localhost:5173` (COOP and COEP only, no CSP; stub API by default); refuses to start without the engine (`client/src/engine/wasm/gen/`, `make engine-wasm`; ADR-0031) | `ci:engine-built` |
| `npm run build` | `tsc -p tsconfig.app.json --noEmit`, then `vite build` into `client/dist/` (hashed names, `assetsInlineLimit: 0`, Vite manifest in `dist/.vite/manifest.json`); fails without the engine, also with `VITE_ENGINE=canvas2d` (`the chart engine is not built (src/engine/wasm/gen/ is missing): run make engine-wasm first`) | build, `ci:engine-built` |
| `npm run preview` | Serves `dist/` on `localhost:4173` with the production headers (`config/headers.ts`) and an `/asset-manifest.json` computed from `dist/` when it starts (`config/previewManifest.ts`: every file's SHA-384 and size, `cache-control: no-store`), so the engine's integrity check runs and the engine loads; loopback only (it refuses `--host` and any non-loopback `preview.host`); the BFF's signed manifest is the only deployment path | — |
| `npm run lint` | ESLint (`--max-warnings=0`) and `prettier --check .` | `ci:lint-ts` |
| `npm run typecheck` | `tsc` over `tsconfig.app.json` (browser code), `tsconfig.node.json` (scripts, ESLint plugin, configs; Node ESM resolution) and `e2e/tsconfig.json` (end-to-end tests, bundler resolution, because they import `src/` modules such as the gallery generator and the brush snap unit) | `ci:typecheck` |
| `npm test` | Vitest: project `node` (scripts and config) and project `dom` (jsdom, Testing Library); the only entry point that runs without the engine: Vitest reads `vitest.config.ts`, the client configuration with `absentEngine` (`virtual:dash-engine` is `absent.ts`) in place of `dashEngine`; `vite build` and the dev server never read it, so `VITEST` set does not bypass their refusal | `unit:*`, `ci:engine-built` |
| `npm run e2e` | Playwright against the BFF-served builds ([end-to-end tests](#end-to-end-tests)); a full run also checks the keyboard coverage over its parts | `e2e:*`, `golden:interim-gallery`, `golden:greyscale`, `bench:startup`, `bench:frame-interim-line`, `bench:frame-interim-categories`, `bench:frame-interim-heatmap`, `bench:inp-rooms`, `bench:rooms-long-tasks`, `bench:editor-keystroke`, `bench:logql-completion-latency`, `bench:log-scroll`, `bench:promql-completion-latency`, `bench:log-page-load` |
| `npm run e2e:keyboard-coverage -- <dir> <project>` | The keyboard coverage check over the part files under `<dir>` ([below](#keyboard-coverage-and-e2e-completeness)) | `e2e:a11y-rooms` (CI, merged shards) |
| `npm run e2e:complete -- <listed.json> <project> <shard.json>...` | Every listed test is in exactly one shard (retries allowed) and was not skipped ([below](#keyboard-coverage-and-e2e-completeness)) | `ci:e2e-complete` |
| `npm run tokens` | Regenerates `src/styles/tokens.css`, `tokens.ts` and the engine's `../engine/crates/dash-tokens/src/tokens.rs` from `../design/tokens.toml`; `-- --check` compares instead of writing | `ci:token-lint` (regenerate) |
| `npm run engine-fixtures` | Compares `../engine/fixtures/*.json` with a fresh run of the TS sources of truth; `-- --write` rewrites them ([the engine page](../client/engine.md#parity-with-the-ts-sources)) | `unit:engine-fixtures` (also in `npm test`) |
| `npm run gen:log-transcripts` | Writes the generated paging transcripts `e2e/transcripts/logs-paging-1.json` and `logs-paging-2.json` from `scripts/logTranscripts.ts` (#66 Part C) | `unit:log-transcripts` (compares them byte for byte, in `npm test`) |
| `npm run gen:xss-corpus` | Writes the generated XSS corpus `src/security/sanitise/__fixtures__/xss-corpus.json` from `scripts/gen-xss-corpus.ts` (#198 Part 2b; [the widgets page](../client/widgets.md#the-xss-corpus-and-the-checker)); `-- --check` compares instead | `unit:xss-corpus-current` (in `npm test`) |
| `npm run gen:xss-e2e-cases` | Writes the browser run's case list `e2e/fixtures/xss-e2e-cases.json` (digest, skip reason and image request paths per corpus case) from `scripts/gen-xss-e2e-cases.ts` (#198 Part 3b; [the widgets page](../client/widgets.md#the-case-list-and-the-baselines)); `-- --check` compares and prints the differences by id | `unit:xss-e2e-cases` (in `npm test`); `e2e:widget-text-xss` |
| `npm run token-lint` | Colour, size, duration and state-token literals outside the tokens | `ci:token-lint` |
| `npm run size` | Brotli sizes of `dist/` (or the build given as `-- <dir>`, e.g. `-- dist-http`) against `bundle-budgets.json` | `ci:bundle-size` |
| `npm run geo-data` | The committed geo assets against `tools/geo/manifest.json` (SHA-256, bytes) and decoded ([geo data](#geo-data)) | `ci:geo-data` |
| `npm run check:lockfile` | Exact versions, lockfile v3, registry and integrity of every locked package | `ci:lockfile` |
| `npm run origins` | No URL of another origin in a resource position of the build, no unlisted URL text; then no forbidden module in the module graphs of `dist` and `dist-http` (`check-bundle-modules.ts`) | `ci:dep-audit` (build origins, module graph) |
| `npm run audit` | Dependency policy, then `npm audit` (runtime high, all critical) and `npm audit signatures` | `ci:dep-audit`, `ci:npm-audit` |

## Checker scripts

Each checker in `client/scripts/` is a Node 24 TypeScript file run directly by `node` (type
stripping), exporting a pure `check…()` or `generate…()` function that the unit tests call, and a
CLI entry. Findings print as `error[<rule>] <path>[:<line>]: <message>`, plus a GitHub annotation
when `GITHUB_ACTIONS` is `true`. No script prints environment values.

| Script | Exit 0 | Exit 1 | Exit 2 | Finding rules | Failing fixtures (T05-002) |
|---|---|---|---|---|---|
| `check-lockfile.ts [dir]` | no findings | findings | unreadable input | `non-exact-version`, `lockfile-version`, `non-registry-resolved`, `missing-integrity` | `scripts/__fixtures__/lockfile/{caret,foreign,no-integrity,v2}` |
| `check-deps.ts [dir]` | no findings | findings | unreadable input | `not-allowlisted`, `not-in-closure`, `stale-closure`, `forbidden-category`, `licence` | `scripts/__fixtures__/deps/*` |
| `bundle-size.ts [dist] [budgets]` | within budget | over budget or an artefact missing | `dist/` or manifest unreadable | `over-budget:<class>`, `missing-artefact:<what>`, `editor-in-initial`, `editor-orphan` | built in a temporary directory by `bundle-size.test.ts` |
| `token-lint.ts [root]` | no findings | findings | a file does not parse | `colour-literal`, `size-literal`, `duration-literal`, `state-token`, `computed-token-name`, `suppressed-token-rule` | `scripts/__fixtures__/token-lint/bad` (and `good`, which must pass) |
| `gen-tokens.ts [--check]` | written / up to date | a generated file is stale (`stale-generated:<file>`, including `engine/crates/dash-tokens/src/tokens.rs`) | invalid tokens (the message names the key) | — | `gen-tokens.test.ts` (`canvas = "blue"`, a stale `tokens.rs`) |
| `engine-fixtures.ts [--write]` | written / up to date | a fixture is stale (`error[engine-fixtures] engine/fixtures/<file> is stale`) | — | — | `engine-fixtures.test.ts` (a fresh run equals the committed files) |
| `gen-xss-corpus.ts [--check]` | written / up to date | the corpus is stale (`error[xss-corpus] … is stale`) | — | — | `gen-xss-corpus.test.ts` (a fresh run equals the committed file; one changed expectation gives 1) |
| `gen-xss-e2e-cases.ts [--check]` | written / up to date | the list is stale (`error[xss-e2e-cases] … is stale` and one line per differing id) | — | — | `gen-xss-e2e-cases.test.ts` (a fresh run equals the committed file; one changed expectation gives 1; c14) |
| `check-build-origins.ts [dist] [policy]` | no errors (warnings allowed) | findings | a file does not parse | `third-party-resource`, `third-party-host`, `computed-url`; warning `unused-url-allowlist` | `scripts/__fixtures__/origins/bad` (and `good`) |
| `check-geo-data.ts [root]` | the assets match the manifest and decode | findings | the manifest or an asset missing or unreadable | `sha256-mismatch`, `invalid-asset` | `check-geo-data.test.ts` (a changed byte; a non-decoding asset with its digest in a test manifest; no manifest) |
| `check-bundle-modules.ts [--cache <dir>] <outDir>…` | no findings | findings | a build's `modules.json` is missing or unreadable | `forbidden-module` | `scripts/__fixtures__/bundle-modules/` |
| `pack-assets.ts --gen-key DIR` / `--in DIST --out OUT --key KEY` | packed / key pair written | — | `pack: <reason>` | — | `pack-assets.test.ts` (a symlink, a missing `--in`) |
| `keyboard-coverage.ts <dir> <project>` | covered | findings | a part file unreadable, not JSON, `version` ≠ 1 or of another project; arguments missing | `keyboard-part-missing`, `keyboard-part-duplicate`, `keyboard-empty`, `keyboard-uncovered`, `keyboard-unvisited`, `keyboard-skip-unbacked`, `keyboard-skip-unused` | `keyboard-coverage.test.ts`; `keyboard-coverage-reporter.test.ts` with `scripts/fixtures/kbd-reporter/` |
| `e2e-complete.ts <listed.json> <project> <shard.json>...` | complete | findings | a report unreadable or not JSON; no listed test for the project; no shard report | `e2e-test-missing`, `e2e-test-duplicate`, `e2e-test-not-run`, `e2e-test-skipped`, `e2e-test-failed`, `e2e-skip-unused`, `e2e-test-unexpected` | `e2e-complete.test.ts` with `scripts/__fixtures__/e2e-complete/firefox-log-stream.json` (a real Firefox report) |

### Keyboard coverage and e2e completeness

The keyboard script of `e2e:a11y-rooms` runs as six parts, K1–K5 and K7
([the client page](../client/README.md#keyboard-coverage)). Each part that passes writes
`test-results/keyboard-coverage/<project>-K<n>.json` (`version: 1`, `project`, `part`, and the
sorted `collected`, `operated` and `visited` lists). The coverage rule is checked over the union of
one project's six files:

| Rule | When | Subject |
|---|---|---|
| `keyboard-part-missing` | a part has no file (it did not run, or did not pass) | the part |
| `keyboard-part-duplicate` | two files for one part | the part |
| `keyboard-empty` | no part collected a control | the project |
| `keyboard-uncovered` | a key collected by some part and operated by none (one finding per key, sorted) | the key |
| `keyboard-unvisited` | a required state (`REQUIRED_STATES` in `e2e/keyboardParts.ts`) visited by no part | the state |
| `keyboard-skip-unbacked` | a key in part P's `DRAIN_SKIP` that no part before P in `SINGLE_TEST_ORDER` operated | `P key` |
| `keyboard-skip-unused` | a key in part P's `DRAIN_SKIP` that P did not collect (the skip is stale: remove it) | `P key` |

The two skip rules run only for parts whose file is present, and over the part's skips on that
engine (`drainSkip(part, project)`: a key of `DRAIN_SKIP_ONLY` is a skip only on the engines it
lists, [the client page](../client/README.md#keyboard-coverage)). A skip never enters the part's
`operated`, so a skipped control still has to be operated by some part (`keyboard-uncovered`).

`keyboard-coverage.ts` searches `<dir>` at any depth for `keyboard-coverage/<project>-K*.json`, so
it reads one run's `test-results/` or CI's downloaded shard artefacts alike. A missing `<dir>` has no
files (five `keyboard-part-missing`).

**The reporter** (`scripts/keyboard-coverage-reporter.ts`, in `playwright.config.ts`) runs the same
check at the end of every full run, for each project in the run, so a local `npm run e2e` (with or
without `--project`) fails on a coverage gap or a missing, skipped or failed part. It prints one
stderr line per finding, `keyboard-coverage <project>: <rule> <subject>`, followed by the finding in
the checker format, and sets the run's status to failed. A filtered run cannot hold every part, so it
is not checked; the reporter prints `keyboard-coverage <project>: not checked (<reason>; run has
<parts>)` and leaves the status alone. The reason is the first that applies:

| The run | Reason |
|---|---|
| `E2E_SHARD` is set and non-empty | `E2E_SHARD=<value>` |
| the config has a `shard` | `shard` |
| the config or a project has a `grepInvert`, or a `grep` other than the default `/.*/` | `grep` |
| the arguments after `test` have `-g`, `--grep`, `--grep-invert`, `--shard`, `--last-failed`, `--only-changed`, `--test-list`, `--test-list-invert` or `--list` (bare or `=value`) | the flag |
| the arguments after `test` have a token that does not start with `-` and is not the value of a space-form `-c`, `--config`, `--project`, `--reporter`, `-j`, `--workers`, `--output`, `--trace`, `--retries`, `--timeout`, `--global-timeout`, `--repeat-each`, `--max-failures` or `--tsconfig` | `files <token>` |

A full command with a value flag not in that list in its space form (`--foo value`) reads as
filtered: it says `not checked (files value)`, never passes silently. To check a filtered run's
files, run `npm run e2e:keyboard-coverage -- test-results <project>` after it.

**`ci:e2e-complete`** (`scripts/e2e-complete.ts`) compares the tests `playwright test --list
--reporter=json --project=<project>` names with the JSON reports of the CI shards. A test's key is
`<file> › <describe> › … › <title> [<project>]`; only tests of `<project>` count, and a shard's name
is its report's file name without `.json`. `expected` and `flaky` pass.

| Rule | When (over all shard reports) |
|---|---|
| `e2e-test-missing` | listed, in no shard report |
| `e2e-test-duplicate` | in two shard reports, or twice in one (the message names the shards) |
| `e2e-test-not-run` | in a report with no result |
| `e2e-test-skipped` | ended `skipped`, and no allowed skip matches |
| `e2e-test-failed` | ended `unexpected` |
| `e2e-skip-unused` | an allowed skip for the project that is not listed, or did not end `skipped` |
| `e2e-test-unexpected` | in a shard report, not listed |

A skip is allowed when an entry of `ALLOWED_SKIPS` in `client/config/e2eSkips.ts` has the test's
file (relative to `e2e/`), its own title (the last of its title path) and the project. Skips of the
`E2E_SERVER=preview` guard are never allowed: CI does not run that mode. **Adding a skip:** add an
entry with the file, the title, the projects and the reason, in the same change as the
`test.skip`; the check fails until both are there, and fails again (`e2e-skip-unused`) if the skip
is later removed but the entry is not.

### Bundle budgets

CI runs the check on the stub build (`dist/`) and on the HTTP build (`dist-http/`). The HTTP build
is authoritative for required lazy entries, because the stub build's `src/dev/` harness routes can
keep an entry alive that the app no longer imports (#135).

`bundle-size.ts` (`ci:bundle-size`, PRF-009, PRF-033) reports one row per budget class:

| Class | Measured | Budget (brotli) |
|---|---|---|
| `initialJs` | the entry and the initial route module with their static imports | 200 000 |
| `initialCss` | the CSS of those chunks | 30 000 |
| `editorChunk` | one row, `editor closure (<n> files)`: the files of the `editorModules` entries (`src/editor/editor.ts`, `src/editor/lang/promql/promql.ts`, `src/editor/lang/logql/logql.ts`, `src/editor/logqlEditor.ts`; every entry is also a required lazy module, so a missing one fails as `missing-artefact`) and every `assets/editor-*.js` file reachable from them through static manifest `imports`. The walk goes only through `editor-*` files: an import of the entry, a shared chunk or the route chunk is neither counted nor walked through, and that file keeps its own row | 175 000 |
| `lazyChunk` | each other non-initial `.js` file (the route chunk `MetricsPage-*` included) | 120 000 each |
| `fonts`, `totalExceptEngine` | the fonts; every file except the engine's | 150 000; 1 000 000 |
| `geoBasemap`, `geoGazetteer` | with `required.geoAssets`: rows `geo-basemap` and `geo-gazetteer`, the one `assets/basemap-<hash>.json` and the one `assets/gazetteer-<hash>.json` (none or several fails `missing-artefact:geo basemap` / `geo gazetteer`); both also count in `totalExceptEngine`. The `geo-assets` entry chunk that names them (`src/vis/geo/urls.ts`, an extra Rolldown input of `vite.config.ts`, plan #231) is a `lazyChunk` row and empty until a route imports it, so the initial JS does not move | 40 000; 104 000 |
| `engine` | one row, `engine (<n> files)`: every `assets/dash-engine-*.js` and `.wasm` (the wasm, its worker bundles and adapter chunks; PRF-009, ADR-0014 §8). Required: no engine wasm fails `missing-artefact:engine`; an engine file in the initial JS fails `engine-in-initial` | 1 900 000 |

Every chunk holding an editor module is named `editor-<hash>.js` by `vite.config.ts`, so the
closure and `e2e:lazy-load` can name the editor's files. `editor-in-initial` fails when a closure
file is in the initial JS; `editor-orphan` fails when an `assets/editor-*.js` file is outside the
closure (named as editor code, but no editor entry reaches it). The editor entries are also
`required.lazyModules`, so a build that drops them fails `missing-artefact`. The CI proof that the
editor row fails over budget is the branch `gate-proof/63-editor-chunk` (budget `editorChunk`
lowered to 50 000), run as a draft PR whose `check` job must fail on `over-budget:editorChunk`.

`pack-assets.ts` is not a checker: it packs the build the BFF embeds
([Serving the client](../server/README.md#serving-the-client)).

The rules of each checker are described where they are used: token-lint in
[the client page](../client/README.md#tokens-and-token-lint), the dependency checks and the
build-origin check in [the supply chain page](../client/supply-chain.md).

## Tests

- **Shared fixtures.** The decoder and step tests import `wire/fixtures/json/*.json` with `?raw`;
  `vite.config.ts` allows `../wire` for that (`server.fs.allow`). See
  [testing against PulsusDB](testing-pulsusdb.md#shared-fixtures-wirefixtures).
- **Unit and component tests** (`npm test`) sit next to the code as `*.test.ts(x)`. Component tests
  render the whole app with `src/test/renderApp.tsx` (`renderApp(url, { api, now, timeZone,
  queryClient, wrapper })`; `wrapper` provides, for example, a fake chart engine) on a memory router, with the stub API and a fixed clock
  (`T` = 2026-11-19 13:03 UTC, zone Europe/London). Its query client has `retry: false`; tests of
  the production retry pass `createQueryClient()`.
- **Async settling in unit tests** (issue #144). Two rules keep tests that wait on asynchronous
  work deterministic:
  - A test that settles a scripted call waits until the query layer has notified its observers.
    The query layer delivers in its own 0 ms timer, queued at the end of the microtasks that follow
    the settlement, so one `setTimeout(0)` after the promise is not enough: when the loop's
    millisecond clock ticks between the two timers, the test's timer fires first and the assertion
    sees the old state. The `resolve` and `reject` of `src/test/logsPageKit.tsx` wait two 0 ms
    timers. The second is created after the query layer's timer, and 0 ms timers run in creation
    order. `unit:logs-page-kit` (`src/test/logsPageKit.test.tsx`, K1 and K2) holds that contract:
    on fake `setTimeout`, it ticks the clock 1 ms before a late 0 ms timer and checks that the
    kit's promise resolves after that timer has fired.
  - A test whose outcome depends on component timers (debounces, `requestAnimationFrame` loops,
    simulated latency) runs them on fake time, not on real-time sleeps:
    `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame',
    'cancelAnimationFrame'] })`, then `act(() => vi.advanceTimersByTimeAsync(ms))`. Keep
    `setImmediate` real, because React's `act` resolves through it, and call `vi.useRealTimers()`
    in a `finally`. Helpers that wait on a real `setTimeout` never resume under fake timers. The
    example is `L16` in `src/logs/LogStream.test.tsx` (`unit:log-stream`).
- **End-to-end tests** (`client/e2e/*.spec.ts`) run in Chromium, Firefox and WebKit against the
  BFF, which serves the client with the production headers; see
  [end-to-end tests](#end-to-end-tests). `Date.now()` is frozen with `page.clock.setFixedTime(T)`.
  To run one engine locally: `npm run e2e -- --project=chromium`.
- **Keyboard coverage** (`e2e/keyboard.spec.ts`, part of `e2e:a11y-rooms`): see
  [the client page](../client/README.md#keyboard-coverage).
- **`bench:inp-rooms`** (`e2e/perf-inp-rooms.spec.ts`, Chromium only, PRF-033, T05 §4.3): scripted
  pointer and keyboard interactions on the board room (Appendix C-A §A.6 of plan #61 Part C), in
  five documents: `/t/demo/board/b-1` (the section toggle five times both ways, the star three
  times both ways), `/t/demo/board/b-3` (a variable chip, typing and Apply; `+ Filter`, Add and
  Remove filter; three times each), `/t/demo/board/b-1` again (Edit board, Add section, Done
  and Discard changes, three times), and `/t/demo/board/b-1` a third time with the panel editor
  scenario of #90 (`e2e/boardEditorScenario.ts`, 43 clicks and key presses: Edit board, then three
  rounds of opening the editor from the Panel menu, typing in Title, picking a query language,
  typing in Query, picking a visualisation, and Done), and `/t/demo/board/b-1` a fourth time with
  the chart gestures of #93 (`e2e/chartGestureScenario.ts`, at most 14 interactions, all on
  `Request rate`: three rounds of ten wheels, eight pinch wheels with `Control`, eight `Shift`
  wheels until **Reset Y axis** shows, a click on it, three left drags of 150 px, three right drags
  of 120 px and a double-click; each commit is awaited through the URL; wheels are not Event Timing
  interactions). An init script observes the Event Timing entries (`event`,
  `durationThreshold` 16) in every document the page loads and flushes them before each
  navigation; `scripts/inp.ts` (`aggregateInp`, `gateFailures`) computes **INP per document**
  (each interaction once, at its longest entry; the durations padded with zeros to the
  document's scripted count, then the `floor(n / 50)`-th largest, so one outlier per 50
  interactions of that document is ignored), never pooled across documents. The test always
  checks five documents, each with its scripted count (document 5's count is an upper bound,
  `CHART_SCENARIO_N`), and no page error. The 200 ms limit
  applies per document; 100 ms is the target. On CI's shared runners the check is **report only**
  until the reference lab exists (#68, T05-006): a document above 200 ms adds a `warning`
  annotation. With `INP_GATE=enforce` (the reference lab, and local gate proofs) any document above
  200 ms fails the test, naming the document, its INP and its slowest step. Both modes write
  `test-results/bench-inp-rooms.json` (`documents[]` with `doc`, `url`, `inp`, `n`, `reported`,
  `slowest`; `worst`, `mode`, `limitMs`, `targetMs`, `unit`) and a `bench:inp-rooms` annotation with
  the same JSON. To run it alone: `npx playwright test perf-inp-rooms --project=chromium`
  (`INP_GATE=enforce npx playwright test perf-inp-rooms --project=chromium` for the blocking form).
- **`bench:rooms-long-tasks`** (`e2e/perf-rooms-long-tasks.spec.ts`, Chromium only, PRF-005, T05
  §4.3, T08 §7; #90): main-thread long tasks during scripted room interactions, from a Chromium
  trace. Its scenarios are the panel editor (`e2e/boardEditorScenario.ts`, as document 4 of
  `bench:inp-rooms`), in a second test the chart gestures (`e2e/chartGestureScenario.ts`, as
  document 5, #93), in a third "board editor, 8 thresholds" (`e2e/thresholdsEditorScenario.ts`,
  #64 Part B: Add threshold up to 8 steps on Request rate, then reopen the editor and edit the last
  step's value, state and label), each on `/t/demo/board/b-1` with no fake clock, and in a fourth
  "gallery near-limit" (`e2e/galleryExtremeScenario.ts`, #97): on `GALLERY_URL`, tracing starts
  once every gallery chart has drawn, then 20 wheel steps (time zoom; the value band is avoided) at
  the centre of `line-extreme`'s plot, each followed by one animation frame, then its redraw. Around the scenario it records a
  trace with the categories `devtools.timeline`, `disabled-by-default-devtools.timeline` and
  `blink.user_timing`; each step leaves a `step:<label>` mark. `scripts/longTasks.ts` reads it:

  | Rule | Definition |
  |---|---|
  | Main thread | the `CrRendererMain` thread with the most `EventDispatch` events; none → error `no renderer main thread` |
  | Inputs | its `EventDispatch` events of the `inputs` option's types: by default `DEFAULT_INPUTS` (`click`, `keydown`, `keyup`, `keypress`, `pointerdown`, `pointerup`, `mousedown`, `mouseup`, `input`); the chart test passes `CHART_INPUTS`, which adds `wheel`, `pointermove`, `mousemove`, `contextmenu` and `dblclick`; none → error `no input` |
  | Counts | `counts`: the number of input `EventDispatch` events per type in the window |
  | Window | from the first input's start to the last input's end |
  | Long task | a `RunTask` on the main thread that overlaps the window and lasts over 16 ms wall |
  | Thread time | the task's `tdur`; when no task in the window has one, error `no thread time` (the CI check cannot be judged); a single task without it counts as failing when over 50 ms wall |
  | Label | the last `step:` mark at or before the task, else `unlabelled` |

  The editor test writes `test-results/bench-rooms-long-tasks.json`, the chart test
  `test-results/bench-rooms-long-tasks-chart.json` and the thresholds test
  `test-results/bench-rooms-long-tasks-thresholds.json` and the gallery test
  `test-results/bench-rooms-long-tasks-gallery-extreme.json` (`clicks`, `keydowns`, `windowMs`, `tasks[]`
  with `tsUs`, `durMs`, `threadMs` and `label`, `over16`, `ciOver`, `worstMs`, `counts`,
  `scenario`, `mode`, `unit`), each with a `bench:rooms-long-tasks` annotation naming its scenario.
  The editor test asserts at least 28 clicks and 15 key presses; the chart test at least 40 wheels,
  8 pointer downs and 3 context menus; the thresholds test at least 17 clicks and 8 key presses; the
  gallery test at least 20 wheels (it parses with `CHART_INPUTS`). All four assert no page error and `ciOver` 0: no task over 50 ms wall with over 16 ms thread time, T05 §4.3's
  interim trace check. That check **blocks merge** on CI, in the `e2e` job's Chromium `rest` shard (the
  spec is Chromium only, so no workflow change). With `LONG_TASK_GATE=enforce` (the reference lab,
  #68, and local gate proofs) it also asserts `over16` 0: no task over 16 ms wall. Without it, each
  such task adds a `warning` annotation.

  | Where | Command | Asserts |
  |---|---|---|
  | CI, `e2e` job, Chromium `rest` shard | `E2E_SHARD=rest npm run e2e -- --project=chromium` | `ciOver` 0 |
  | Local gate proof, reference lab | `LONG_TASK_GATE=enforce npx playwright test perf-rooms-long-tasks --project=chromium` | `ciOver` 0 and `over16` 0 |
- **`bench:startup`** (`e2e/perf-cold-load.spec.ts`, Chromium only, report only, PRF-008): 20 cold
  loads of `/t/demo/boards`, time to the `shell-ready` performance mark; p50 and p75 are written to
  `test-results/prf-008.json` and added as a test annotation. There is no threshold.
- **Chart tests** (#58; see [Charts](../client/charts.md)). The engine's unit tests draw into
  `src/test/recordingContext.ts`, a 2D context that records every call (text measured at 7 px per
  character), and run the animation frames themselves (`src/test/engineHarness.ts`); component tests
  use `src/test/fakeEngine.ts` and `src/test/fakeResizeObserver.ts`. The end-to-end chart specs use
  the chart gallery at 12:00–13:00 UTC on 19 Nov 2026 (`GALLERY_URL` in `e2e/helpers.ts`):
  - **`unit:value-ticks-bounded`** (`src/engine/canvas2d/valueTicks.bounded.test.ts` and the
    in-process rows of `valueTicks.test.ts`; #97): `valueTicks` returns finite, bounded ticks for
    every finite domain, including overflowing spans, ±MAX ends, equal ends, subnormal spans, short
    plots and rounded duplicates. Each row runs `scripts/value-ticks-probe.ts` (modes `ticks`,
    `prop` and `draw`) in a child process killed after 5 s (10 s for the 10 000-case property run
    and the `line-extreme` draw), with a 15 s test limit, so a search that never finishes fails
    instead of hanging the run. `node scripts/value-ticks-probe.ts ticks <min> <max> <height>
    <label> <base>` prints one result as JSON.
  - **`unit:event-marks`** (`src/engine/canvas2d/eventMark.test.ts` and `markers follow the pan
    preview` in `Canvas2DEngine.camera.test.ts`; #64 Part C, ADR-0023): the label band, one line
    per event in view (none outside, none for a non-finite time), the layering over heatmap cells,
    full-height bars and thresholds, `+N` chips, truncation before the next label, the right edge,
    merges, the narrow-plot box without text, no glyph for a note, nothing on stat, and 200 seeded
    sets of 1–30 events at widths 40–800 px (boxes inside the band, gaps of at least 4 px, every
    event in view in exactly one box). Two tests measure text at 6 px per code point instead.
  - **`unit:board-events`** (`src/boards/boardEvents.test.tsx` and the `event markers` tests of
    `src/pages/board/BoardPanels.test.tsx`, plus `event hit targets` in `ChartFrame.test.tsx` and
    `listAnnotations` in `HttpApi.test.ts`): one events request per window for a 30-panel board,
    the old one aborted; an absolute Refresh now aborts the request in flight and makes one more;
    markers sorted by `(atMs, id)`; none while disabled; the failed and truncated notices; one
    markers array for line, bars, heatmap and stat panels; a board with sections only (collapsed
    too) still asks; the hit targets' labels, size and tooltip.
  - **`golden:interim-gallery`** (`e2e/golden-gallery.spec.ts`, Chromium only): each of the sixteen
    gallery frames (with `line-thresholds` and `stat-sparkline`, #64 Part B, `line-extreme`, #97,
    `line-events`, #64 Part C, and the five bar charts `barchart`, `barchart-thresholds`,
    `barchart-dupes`, `barchart-subset` and `barchart-cap`, #173 Part 2) in dark and light, compared
    with `toHaveScreenshot` against
    `e2e/__screenshots__/golden-gallery.spec.ts/gallery-<id>-<theme>.png` (per-pixel threshold 0.1,
    at most 0.2 % of pixels different, animations off, caret hidden, CSS scale), after the fonts are
    loaded and two animation frames; a reload must give the same pixels. **`golden:greyscale`**
    (same file, VIZ-067): the five bar charts in dark with every canvas set to `filter:
    grayscale(1)` through CSSOM (the page's CSP refuses an injected style tag), against
    `gallery-<id>-greyscale.png`; the bars must be told apart by their names alone. Baselines are
    never written on a normal run (`updateSnapshots: 'none'`). Since 2026-11-25 GitHub Actions is
    not a gate: a change regenerates its baselines locally with `PW_UPDATE_GOLDENS=1` in a
    container built from the CI image definition (Ubuntu 24.04, Node 24.22.3, Playwright 1.65.0
    and its pinned browsers), reviews the images and commits them to
    `client/e2e/__screenshots__/`. `PW_UPDATE_GOLDENS=1` rewrites every shot of the run; restore
    the unchanged baselines that differ only within the threshold before committing.
  - **`e2e:chart-brush`** (`e2e/chart-brush.spec.ts`): a right drag on `line-1` from 0.1–0.4 brush
    units inside 12:20 to the same inside 12:25 must give exactly `from=…12:20:00.000Z`,
    `to=…12:25:00.000Z`; a double-click then gives 12:17:30–12:27:30 and the header shows it; an
    `Alt`+left drag over the same span gives the same window (#93; a left drag now pans).
  - **`e2e:chart-zoom`** (`e2e/chart-zoom.spec.ts`, Chromium, Firefox and WebKit; #93). Charts below
    the fold are scrolled into view without a wheel first.
    - Z1: ten wheels at 30 % of `line-1`'s plot keep the time under the pointer within 1 px in the
      committed URL window; Back restores 12:00–13:00 (one entry per gesture; when a loaded runner
      delivers two wheels more than 300 ms apart, Back walks each entry).
    - Z2: a wheel over the intro and one over the value-axis band scroll the page and leave the URL;
      400 ms later a wheel over the plot zooms and does not scroll.
    - Z3: a wheel over the plot within the scroll latch of a page wheel scrolls the page; 400 ms
      later it zooms (an attempt whose wheels arrive 250 ms or more apart is repeated).
    - Z4: `Control` + fractional wheels zoom time only; `Control` + whole steps pins the value axis;
      the page never zooms (WebKit's driver delivers whole steps: the accepted misclassification).
    - Z5: `Shift` + wheel pins the value axis without a URL change; a wheel then changes the URL;
      **Reset Y axis** unpins it.
    - Z6: a 200 px left drag moves the window by 200 px of time, width 1 h.
    - Z7: a right drag gives 12:20–12:25; the `contextmenu` events on the plot (drag, click) are
      prevented and the one on the value-axis band is not.
    - Z8: a drag on the time-axis band moves the window; a drag on the value-axis band pins the value
      axis; a double-click there unpins it.
    - Z9: on `/t/demo/board/b-3` a wheel over `Edge p99` moves every panel's window to the URL; a
      `Shift` wheel pins only `Edge p99`; Back restores every slider's window.
    - Z10: five wheels on `bars` leave its `data-plot` unchanged through each preview, the commit and
      the refetch, and the time under the pointer within 1 px.
  - **`e2e:chart-hover`** (`e2e/chart-hover.spec.ts`): the `line-gaps` tooltip lists the time and the
    three series with the values the generator gives; on `line-50` a pointer sweep down the plot
    shows every one of the 50 series; on `bars` all five levels at every height.
  - **`bench:frame-interim-line`** (`e2e/perf-chart-redraw.spec.ts`, Chromium only, report only
    until #68): 40 theme changes, the `chart-draw` measure of the 50 × 1 440 line chart each time;
    p50 and p95 are written to `test-results/bench-interim-line.json` and added as an annotation.
    There is no threshold. The page is opened without Playwright's fake clock, which replaces the
    User Timing methods. A separate test, `bench:frame-interim-line line-extreme (report only)`, on
    its own page and with a 30 s limit, does the same for the `line-extreme` frame (the measures
    whose `detail.frame` is that frame's `data-frame-id`; #97) and writes
    `test-results/bench-interim-line-extreme.json` with a `bench:frame-interim-line line-extreme`
    annotation. Both assert at least 40 samples. **`bench:frame-interim-categories`** (same file,
    report only; #173 Part 2) opens the gallery with `&bench=categories` (only `barchart-cap`,
    600 px wide with a 2 800 px category extent, so 200 bars), makes 50 theme changes and records
    the `chart-draw` measures with `detail.series` 200; p50 and p95 go to
    `test-results/bench-interim-categories.json` and an annotation. No threshold.
  - **`e2e:gallery-extreme`** (`e2e/gallery-extreme.spec.ts`, Chromium, Firefox and WebKit; #97,
    60 s limit): the `line-extreme` frame (values over [−MAX, MAX]) becomes ready with a non-empty
    plot, and the page then answers an `evaluate` within 2 s.
  - **`e2e:ticks-parity`** (`e2e/ticks-parity.spec.ts`, Chromium, Firefox and WebKit; #97, 60 s
    limit): `src/engine/canvas2d/valueTicks.ts` is type-stripped (`node:module`
    `stripTypeScriptTypes`) and loaded as a classic script into a blank page; each of the 897 rows
    of `engine/fixtures/ticks.json` and `ticks-extreme.json` is computed in the page and compared
    with its `out` (`===`, NaN equal to NaN) and its recorded `path` (#126): every engine must
    take the recorded path and equal `out` exactly (`min`, `max`, the tick count and every tick) on
    every row. Before the rows, the page's `pow10` and `powBase` must equal all 855 rows of
    `engine/fixtures/pow.json` (`Object.is`). A failure lists the first 10 differing rows.
  - **`unit:js-pow`** (`src/engine/canvas2d/valueTicks.pow.test.ts`; #126): the interim tick
    powers `pow10` and `powBase` equal every row of `engine/fixtures/pow.json` (V8's `**` under
    Node 24.22.3) and equal `**` at the edges (NaN, ±∞, below −340, above 308 and 102, negative
    p); `SPAN_HALF_LIMIT` is 2^1022; and `valueTicks.ts`, comments removed, contains no `**`, so
    no browser engine's own `pow` decides a tick ([the engine page](../client/engine.md)).
  - **`bench:frame-interim-heatmap`** (`e2e/perf-heatmap-draw.spec.ts`, Chromium only, report only
    until #68, skipped under `E2E_SERVER=preview`): on the Vite dev server (5174) the page imports
    the engine's `draw.ts`, `palette.ts` and `dev/synth.ts` and draws a 10 000 × 200 heatmap
    (`synthHeatmap`, seed 20261120, every 97th cell NaN) into a 1 200 × 400 `OffscreenCanvas`: 10
    warm-up draws, then 50 timed with `performance.now()`. It asserts 50 samples and a heatmap
    summary, writes p50 and p95 to `test-results/bench-interim-heatmap.json` and adds an
    annotation. There is no threshold on shared CI. `HEATMAP_BENCH_NAN=0` draws the same fixture
    without NaN cells. A change to the interim heatmap draw path (`columns.ts`, `draw.ts`) records
    a local before/after run in its PR: 3 runs each with the base's files and the branch's, with
    and without NaN cells; the median after-p95 is at most 1.10 × the median before-p95.

- **`bench:editor-keystroke`** (`e2e/perf-editor-keystroke.spec.ts`, Chromium only, PRF-005,
  T09-003): on the stub build, with no fake clock (it would replace `performance.now`), two cases
  through one body (`keystrokeBench`):
  - **PromQL** (`bench:editor-keystroke`): 100 keys (` or up`, cycled, after 20 warm-up keys) typed
    at the end of a 1 KB PromQL query in Explore › Metrics; report
    `test-results/bench-editor-keystroke.json`.
  - **LogQL** (`bench:editor-keystroke logql`, #66): 100 keys (`error `, cycled, after 20 warm-up
    keys) typed before the final `"` of the last line filter of a 1 024-byte, one-line LogQL query
    (`{app="checkout",env="prod"} | json`, 20 label filters, `|= "xxx…"`) on the dev-only harness
    `/t/demo/dev/logql-editor` (the caret context is `none`, so both completion slots run and return
    nothing); report `test-results/bench-editor-keystroke-logql.json`.
  - **Logs page** (`bench:editor-keystroke logs page`, #66 Part C): the same 1 024-byte LogQL query
    and keys on Explore › Logs (`/t/demo/explore/logs?from=now-1h&to=now&refresh=off&q=…`), ready
    once the `LogQL query` textbox and the stub's `Log lines` list are visible, so the keys run with
    the stream mounted; report `test-results/bench-editor-keystroke-logs-page.json`.
  - **Editor update (T09-003).** Before the page loads, the spec installs
    `window.__pulsusEditorProbe`; the editor (`src/editor/probe.ts`, `probedDispatch`) then times
    each `view.update(trs)`. A key's work is the sum of its doc-changing updates minus the median of
    30 samples without a key. Without the probe, CodeMirror's own dispatch runs unchanged.
  - **Long tasks (PRF-005).** A Chromium trace of the 100 measured keys is read by
    `scripts/longTasks.ts` (the `bench:rooms-long-tasks` parser): the page's renderer main thread,
    from the first to the last input.
  - **Always (blocking in CI's `e2e` Chromium `rest` shard):** 100 samples, every key with an editor update,
    at least 100 keydowns in the trace, the final text length, and `ciOver` 0 (T05 §4.3's interim
    check: a task fails only over 50 ms wall **and** over 16 ms thread time, or without thread
    time).
  - **`EDITOR_BENCH_GATE=enforce`** (the reference lab, #68, and the local D13 proofs) also fails on
    an editor-update p95 over 2 ms or any task over 16 ms wall (`over16`); otherwise each breach is a
    `warning` annotation.
  - Report (each case): `samples`, `overheadMs`, `p50`, `p95`, `max`, `longestTaskMs`,
    `longTasks`, `ciOver`, `windowMs`, `mode`.
- **`bench:logql-completion-latency`** (`e2e/perf-logql-completion.spec.ts`, Chromium only,
  T09-007, T09 §7, #66): on the stub build's LogQL harness, whose in-memory source answers at once,
  so the client alone is timed: keydown `timeStamp` to the completion popup's insertion in the
  editor's shadow root (a `MutationObserver`). 30 local trials (`|` after `{app="web"} ` opens the
  stage list from the synchronous slot; then Escape, Backspace and two frames) and 30 remote trials
  (`w` inside `{app=""}` opens the label values after the 120 ms debounce; then Escape, Backspace
  and 200 ms). The probe, trial, percentile and summary helpers are in `e2e/completionLatency.ts`,
  shared with `bench:promql-completion-latency`.
  - **Always:** 30 + 30 samples and remote min ≥ 120 ms (the debounce is never skipped, and its
    timer never fires early).
  - **`EDITOR_BENCH_GATE=enforce`:** local p95 ≤ 16 ms and remote p95 ≤ 136 ms (the debounce plus
    one frame); otherwise each breach is a `warning` annotation. A lab-gate row: report-only on
    shared CI until the reference lab exists. Chromium runs a timer queued by a key only after the
    frame that follows the key, and the two frames between local trials put each key just after a
    frame, so a local sample is about one frame (16–17 ms at 60 Hz) on a workstation.
  - Report: `test-results/bench-logql-completion.json` (`{local: {p50, p95, max}, remote: {…}}`).
- **`bench:promql-completion-latency`** (`e2e/perf-promql-completion.spec.ts`, Chromium only,
  T09-007, T09-008, T09 §7, PRF-005, #107): on the stub build's Explore › Metrics, whose source
  (`createPromSource` over `StubApi`) answers at once, so the client alone is timed; no fake clock.
  Keydown `timeStamp` to the popup's insertion, as above (`e2e/completionLatency.ts`).
  - **Local** (30 trials): `/t/demo/explore/metrics?from=now-1h&to=now&refresh=off&q=…` with
    `'up + '.repeat(203) + 'sum(up)'` (1 022 bytes, asserted to parse without an error node), the
    caret before the last `up)`; `r` (`sum(r‸up)`: functions from the local slot, metric names
    waiting in the remote one), then Escape, Backspace and two frames.
  - **Remote** (30 trials): `up{job=""}` with the caret between the quotes; `a` opens the stub's
    label values after the 120 ms debounce, then Escape, Backspace and 200 ms.
  - **Work per local key.** The page is opened with two probes installed (`addInitScript`): the
    editor probe (each `view.update`: `doc` when it changes the document, else `view`) and the
    completion probe (`slot0entry`, `slot0`, `slot1entry`, `slot1pre`, `slot1post`;
    `src/editor/probe.ts`). Each pushes `[performance.now(), ms, kind]` to `window.__work` when
    its work ends, so an entry is the interval `[end − ms, end]`. `keyWork` is the length of the
    **union** of the intervals that end between a local trial's keydown and its popup, except
    `slot1post`: the key's document update, its local completion work (slot 0, and slot 1 up to
    its wait) and the popup render, all the main-thread work the key causes up to the visible
    list. The report also gives the parts (`docMs`, and `completionMs`, the union of the four
    local completion segments). The measurement is segmented: no timer spans an await. Each slot
    reports its entry up to its await on the shared analysis (`slot0entry`, `slot1entry`; the
    slot that runs first computes the analysis there, so that work is counted once) and its work
    from resuming to its result or its wait (`slot0`, `slot1pre`). Other microtasks that run while
    a slot waits fall between its segments and are not counted, nor is the package's own
    continuation of the analysis, which runs in those microtasks; the union counts nested or
    overlapping intervals once. The arithmetic and the gate are in `src/test/completionWork.ts`,
    checked with injected samples by `completionWork.test.ts` (overlapping, contained and
    disjoint intervals; each part under 2 ms with their union over, red under enforce) and by
    `unit:promql-completion-probe` on an injected clock: Z1 (each slot reports a segment either
    side of its await, and `completionMs` is their union) and Z2 (5 units of unrelated microtask
    work queued while the slots await the analysis lie outside every interval, so neither
    `completionMs` nor `keyWork` includes them). `remoteWork` (`slot1post` and `view` from 120 ms after the keydown to
    the merged list) is reported only: it runs in its own timer task after a fetch, so its bound is
    PRF-005's per-task limit, which the trace gates.
  - **Long tasks.** A Chromium trace from the first local trial to the last remote one, read by
    `scripts/longTasks.ts`.
  - **Always (blocking in CI's `e2e` Chromium `rest` shard):** 30 + 30 samples; remote min ≥ 120 ms; local
    p50 < 100 ms (a list held behind the 120 ms typing delay or CodeMirror's 100 ms sync wait gives
    every sample ≥ 100 ms); `ciOver` 0; 30 `keyWork` samples, each with at least one `doc` and one
    `slot0` entry (both probes are wired).
  - **`EDITOR_BENCH_GATE=enforce`:** local p95 ≤ 16 ms, remote p95 ≤ 136 ms, `over16` 0 and
    `keyWork` p95 ≤ 2 ms; otherwise each breach is a `warning` annotation. A lab-gate row, as above.
    On a workstation `docMs` alone is several ms for this query (the incremental parse of a
    204-term binary expression), on `main` as on this branch.
  - Report: `test-results/bench-promql-completion.json` (`{local, remote, keyWork: {p50, p95, max},
    docMs: {p95}, completionMs: {p95}, remoteWork: {p50, p95, max}, longTasks, ciOver, windowMs,
    mode}`).
- **The log stream harness** (`/t/demo/dev/log-stream`, development and stub builds only, #66
  Part B): `LogStream` over the synthetic log API, prefilled to a configured size; a spec sets
  `window.__logStreamBenchConfig` with `page.addInitScript` before the page loads, waits for
  `[data-prefilled="true"]` and drives `window.__logStreamBench`
  ([Log stream](../client/logs.md#the-harness-and-its-gates)).
- **`e2e:log-stream`** (`e2e/log-stream.spec.ts`, Chromium, Firefox and WebKit; E6 Chromium only,
  PRF-020, VIZ-034): "at rest" is no `scroll` event for 300 ms. E1 the top row keeps its ordinal and
  offset (within 1 px) across far-end eviction, fixed and wrapped rows; E2 the same across three
  re-slices of a 2 000-row slice, wheel 400 px per step; E3 the last of 10⁶ held rows (`End`) is
  inside the scroller; E4 wrapping keeps the top row, a 400-character line wrapped to 40–2 000 px;
  E5 a wrapped 20 000-character slice stays within 8 × 10⁶ px with rows of at most 2 000 px and does
  not re-slice or write `scrollTop` for 2 s at rest; E7a and E7b (viewport pinned to 1 440 × 900,
  40 000-character lines estimated one row each, and a precondition that every mounted line wraps
  past 100 lines) rows taller than estimated are re-sliced back within `maxPx` at rest
  (`reslices.extent`) and within `hardPx` while 80 wheel events of 2 000 px run (`reslices.hard`
  while scrolling; the list height sampled each frame stays ≤ `hardPx` + 120 000 px); E6 a CDP touch
  gesture makes no `scrollTop` write while it runs, and the top row is kept at each re-slice.
- **`bench:log-scroll`** (`e2e/perf-log-scroll.spec.ts`, Chromium only, PRF-020, PRF-001, PRF-003,
  PRF-004, PRF-005, #66 Part B): the harness's default config (10⁶ of 2 × 10⁶ entries held, 50 ms
  page latency after the prefill), no fake clock, a rAF recorder of `performance.now()`.
  - **Phases.** 0 ready (10⁶ held, `firstOrd` 0); 1 calibrate: 120 frames at rest at row 500 000,
    `vsyncMs` = the median interval, and the run is invalid under 59 Hz; 2 control: the same gesture
    on `[data-log-control]`, a static scroller of 2 × 10⁶ px with no script (the browser's floor);
    3 fling: `performance.mark('bench:start')`, then CDP `Input.synthesizeScrollGesture` (`yDistance`
    −30 000, `speed` 6 000, mouse) in the middle; 4 crossing: from row 997 500 the same gesture
    across the buffer end, which loads a page (latency 50 ms), renders it and evicts one at the
    head; the window runs to 1 s after the page lands, then `bench:end`; 5 the trace.
  - **Trace.** Categories `devtools.timeline`, `disabled-by-default-devtools.timeline`,
    `blink.user_timing`, `cc`, `benchmark`, `input`, `input.scrolling`. `scripts/longTasks.ts` with
    `marks: {start: 'bench:start', end: 'bench:end'}` counts the tasks between the two marks (a task
    after the last input counts); `scripts/eventLatency.ts` reads every scroll-update `EventLatency`
    (`GESTURE_SCROLL_UPDATE`, `FIRST_GESTURE_SCROLL_UPDATE`, `INERTIAL_GESTURE_SCROLL_UPDATE`), from
    the input's OS timestamp to the presentation of the frame that shows it: the PRF-003 proxy
    (photons are not observable; on the lab the error is at most one refresh plus the panel's
    response time; headless CI presents through a software compositor, an earlier point, so CI
    values are a lower bound and are reported only).
  - **Always (blocking in CI's `e2e` Chromium `rest` shard):** 10⁶ held, the crossing made a request,
    `endOrd − firstOrd` 10⁶ and `firstOrd` ≥ 1 000 after it, at least one `wheel` or `scroll`
    dispatch, `ciOver` 0, at least 50 latencies.
  - **`LOG_BENCH_GATE=enforce`** (the reference lab and the local D13 proofs), unrounded against
    `vsyncMs`: fling median interval ≤ `vsyncMs` at ≥ 60 Hz (PRF-001), every crossing interval up to
    2 frames after the landing ≤ 2 × `vsyncMs` (PRF-020), `EventLatency` median ≤ `vsyncMs` and p99
    ≤ 2 × `vsyncMs` (PRF-003, PRF-004), no task over 16 ms between the marks (PRF-005); otherwise
    each breach is a `warning` annotation. If the lab misses PRF-001 at 10⁶ lines, PRF-020 returns
    to M-UI2 (roadmap Table 2.1b, D6) and #69 meets it.
  - Report: `test-results/bench-log-scroll.json` (`held`, `vsyncMs`, `control`, `fling`,
    `crossing`, `eventLatency`, `longTasks`, `ciOver`, `worstMs`, `windowMs`, `mode`).
- **`bench:log-page-load`** (`e2e/perf-log-page-load.spec.ts`, Chromium only (it skips itself in
  the other engines), http BFF and the fake, PRF-005, PRF-020, #66 Part C): the main-thread cost of
  Explore › Logs loading and decoding a 1 000-entry page over HTTP. The page opens on
  `{app="checkout"}`; the editor text becomes `{app="paging"}` outside the trace; then
  `bench:start`, Run (the response wait registered before the click), `bench:page1` once the row
  `data-ord="0"` reads `paging line 0000` (in the same frame the page records whether any row of
  page two is mounted), wheel to `End of results`, 1 s, `bench:end`. `LogStream` prefetches the next
  page as soon as page one renders, so a **cursor gate** (`page.route` on the path
  `/api/dash/v1/query/logql/range`, which matches the tenant-scoped `…/range?tenant=…` request)
  holds every request with a `cursor` until `bench:page1` is marked: page two's answer and decode
  fall in window two.
  - **Always (blocking in CI's `e2e` Chromium `rest` shard):** exactly two range requests in the windows,
    both `{app="paging"}`, the first without a cursor and the second with one; the gate held one
    request (`cursorHeld === 1`); one volume request with the same text and no other
    `/query/logql/` request; page one's Resource Timing `responseEnd` after `bench:start` and by
    `bench:page1`, page two's after `bench:page1`; no page-two row at the mark; the row
    `data-ord="1499"` (`paging line 1499`) mounted by `bench:end`; `ciOver` 0 over both windows.
  - **`LOG_BENCH_GATE=enforce`:** no main-thread task over 16 ms in either window (PRF-005);
    otherwise each breach is a `warning` annotation. A lab-gate row.
  - Report: `test-results/bench-log-page-load.json` (`page1Ms`, `endMs`, `tasks` per window,
    `worst` per window, `ciOver`, `cursorHeld`, `mode`).
- **`e2e:logs-*`** (`e2e/explore-logs.spec.ts`, Chromium, Firefox and WebKit, http BFF and the fake,
  #66 Part C): `e2e:logs-completion` (`{app="` offers the fake's `app` values), `e2e:logs-run` (the
  raw text, window and `width_px` to the range and volume routes; the volume's summary; six lines,
  the first announced `Error … checkout line F`), `e2e:logs-brush` (a right drag 12:20–12:25 on the
  volume sets the window and reruns both), `e2e:logs-paging` (1 500 lines over two pages, no
  duplicate or missing ordinal), `e2e:logs-metric` (a line chart, no stream, no volume),
  `e2e:logs-cancel` (the superseded range and volume requests are cancelled at the fake),
  `e2e:logs-truncation` (Partial data in the Log lines card; Narrow; the 422 with Narrow),
  `e2e:logs-refresh` (Refresh now under an absolute window reruns both) and
  `e2e:logs-error-on-run` (the underline and `expected '}'`); and `e2e:lazy-load logs` on the stub
  build. The transcripts are `e2e/transcripts/logs-*.json`
  ([Explore: the Logs page](../client/explore.md#e2e-transcripts-and-gates)).
- **`e2e:editor-ime`** (`e2e/editor-ime.spec.ts`, Chromium only, T09-005): a CDP IME composition in
  the Explore editor opens no completion popup while it lasts; the popup follows once it commits.

### End-to-end tests

`npm run e2e` (or `make e2e`) starts four servers (`client/playwright.config.ts`):

| Server | Command | Used by |
|---|---|---|
| PulsusDB fake on `localhost:4190` (first; ready on `/__fake/requests`) | `tools/e2e/fake.sh 4190` | both BFFs' data source; the specs read its request records through `e2e/fake.ts` ([control mode](testing-pulsusdb.md#in-the-e2e-suite-control-mode)) |
| stub-mode BFF on `localhost:4173` | `tools/e2e/serve.sh stub 4173` | every existing spec (`baseURL`): the stub's seeded boards and tenants, served with the real headers; and `e2e:bff-headers` |
| http-mode BFF on `localhost:4174` | `tools/e2e/serve.sh http 4174` | `e2e:bff-http-shell` (`bff-http.spec.ts`): the shell bootstraps from `GET /api/dash/v1/bootstrap`; `e2e:board-edit-save`, `e2e:board-tall` and `e2e:board-sections` (`board-edit.spec.ts`): boards created, laid out, saved and reloaded through the boards API, and collapsed sections, their URL overrides and saved state; `e2e:board-prefs` (`board-prefs.spec.ts`): Starred and Recent across two tabs and a fresh browser context (each test creates its own uniquely named board and deletes it in `finally`); the board PromQL panels of `board-promql.spec.ts` (below) |
| Vite dev on `localhost:5174` | `npx --no-install vite --port 5174 --strictPort` with `VITE_API_MODE=http`, `VITE_ENGINE=canvas2d` and `PULSUS_DASH_DEV_BFF=http://localhost:4174` | `dev-proxy.spec.ts`: the developer path shows the server version |

Before a run:

1. `make e2e-build` builds the two BFF binaries, `build/e2e-stub/pulsus-dash` and
   `build/e2e-http/pulsus-dash` (version `0.1.0-e2e`), each with its client embedded, and the
   fake, `build/e2e-fake/pulsus-fake`. It needs the engine (`make engine-wasm`; `make build`
   runs it).

**Canvas 2D pin.** The GPU chart engine is the default renderer
([ADR-0031](../../designs/adr/0031-gpu-engine-default-renderer.md)), but this suite runs on host
browsers with uncontrolled GPUs, so every build and server it uses pins Canvas 2D with
`VITE_ENGINE=canvas2d`: `make e2e-build` sets it on both builds (`E2E_ENGINE ?= canvas2d`; the
engine is still built in), and the dev server and the `E2E_SERVER=preview` server get it in their
`env`. The Canvas 2D specs keep their URLs; `?engine=wasm` still opts a page in. `e2e:canvas2d-pin`
(`e2e/engine-pin.spec.ts`, every browser, also under `E2E_SERVER=preview`) fails if the pin is
lost: every gallery frame must be `canvas2d` and no `assets/dash-engine-*` file may be requested.
The engine suite ([below](#the-engine-in-the-browser-part-c1)) proves the default.
2. Set `E2E_PG_APP_URL` and `E2E_PG_OWNER_URL` to the `pulsus_app` and `pulsus_owner` URLs of a
   `pulsus_e2e` database on any PostgreSQL 15 or 16 where `server/deploy/postgres-roles.sql` has
   been applied (Part C's development stack is one way to get one), for example
   `postgres://pulsus_app@localhost:55432/pulsus_e2e?sslmode=disable`.

`tools/e2e/serve.sh MODE PORT` runs from the repository root. It needs the binary (else `run make
e2e-build first`) and both variables (else `E2E_PG_APP_URL and E2E_PG_OWNER_URL must be set`). It
sets the `PULSUS_DASH_*` variables (Postgres references to those two variables, datasource
`http://localhost:4190` (the fake) with slug `demo`, listen `localhost:PORT`, text logs), runs
`migrate` (idempotent; the two BFFs serialise on its lock), then `serve`. Locally an already
running server on a port is reused. `tools/e2e/fake.sh PORT` needs `build/e2e-fake/pulsus-fake`
(else `run make e2e-build first`) and serves `client/e2e/transcripts` with `--generate=false
--control`.

The data-source binding is seeded once, when the database is first migrated. A local e2e database
seeded before #63 still points at `http://localhost:9`, and the sidebar then reads `Unreachable`:
drop and recreate it (`DROP DATABASE pulsus_e2e;` then `CREATE DATABASE pulsus_e2e OWNER
pulsus_owner;`). CI creates `pulsus_e2e` per job.

`E2E_SHARD=kbd-a`, `kbd-b`, `kbd-c`, `rest` or `rest-b` runs one CI shard ([E2E shards](#e2e-shards); any
other value fails at config load with `E2E_SHARD must be one of kbd-a, kbd-b, kbd-c, rest, rest-b`). Unset or empty runs
everything. A full run checks the keyboard coverage itself at the end
([the reporter](#keyboard-coverage-and-e2e-completeness)); a filtered run (`E2E_SHARD`, `--grep`, a
file or a line) prints `keyboard-coverage <project>: not checked (<reason>; run has <parts>)`. One
keyboard part runs alone with `npx playwright test --grep "K3 " --project=chromium` (the space
after the part ends the match); `--grep @kbd` runs all five, in parallel.

`E2E_SERVER=preview npm run e2e` restores the old single server (`npm run build && npm run
preview` with `VITE_ENGINE=canvas2d`, no database); the `bff-*` and `dev-proxy` specs then skip themselves. `bff-headers`,
`bff-http`, `dev-proxy`, `editor-ime`, `perf-editor-keystroke`, `perf-logql-completion` and
`perf-log-scroll` and
`perf-promql-completion` run on Chromium only; `perf-log-page-load` skips itself outside Chromium.
The Explore specs on the fake (`e2e/explore-metrics.spec.ts`, `e2e/explore-logs.spec.ts`) run on
the http-mode BFF and, where they read the fake's request records, use one time window per browser,
so parallel projects never count each other's requests (the Logs specs read their own requests in
the browser otherwise).

- **`e2e:bff-headers`** (`bff-headers.spec.ts`): `GET /` has `Content-Security-Policy` equal to
  `CSP` from `config/headers.ts` and every other document header; the first `/assets/*.js` the page
  loads, requested with `Accept-Encoding: br`, is served `br` and `immutable`; `/t/demo/boards`
  returns `index.html`; `/api/nope` is the 404 envelope.
- **Panel editor dialog** (`panel-editor-dialog.spec.ts`, #90, all three engines): the dialog's
  size, position and backdrop, focus containment and return, and the live preview. Its frame-timing
  cases (E4, E7–E16) run without the fake clock, which would replace the page's User Timing
  methods: an init script observes the engine's `chart-draw` measures (with `detail.frame`, the
  frame id) and the stub's `stub:query` marks (`{ kind, query }`, plan #64), and snapshots the
  preview in the first animation frame after an input, in that frame's resize-observer step (what
  the frame paints), and one frame later. A query runs on Shift+Enter (plan #64 §4.4) and a
  visualisation change makes no request. They use the stub's test hooks
  `pulsus-dash.stub.queryDelayMs` (a delay in ms for every `queryRange` and `queryInstant` call,
  never consumed) and `pulsus-dash.stub.failQuery` (fail the next n calls); see
  [the client page](../client/README.md#stubapi).
- **Board PromQL panels** (`board-promql.spec.ts`, plan #64 Part A A.3, all three engines, on the
  http-mode BFF and the fake; each browser uses its own days from 2026-02-01, so parallel projects
  never count each other's requests): **`e2e:board-promql-panels`** (a counter, a histogram and a
  gauge panel typed into the panel editor draw a rate line, a heatmap and a line; an override to
  Stat survives save and reload), **`e2e:board-visible-only`** (30 panels, 6 on screen: exactly 6
  range queries on open, only the newly visible ones on scrolling, none on scrolling back),
  **`e2e:board-cancel`** (two window changes while three panels load: every superseded request
  cancelled, three completed for the last window), **`e2e:board-open-in-explore`** (the link carries
  the panel's query and the board's time; at a 5 m step `$__interval` and `$__rate_interval` are
  `[5m]` and `[20m]`), **`e2e:board-refresh`** (Refresh now under an absolute window reruns both
  panels, #101) and **`e2e:board-states`** (Partial data with its notices, a too-broad error with
  Narrow, a parse error with line and column, and an empty panel that sends nothing).
  E1 also checks that the counter panel shows its legend. The boards API helpers (`createBoard`,
  `deleteBoard`, `panelSpec` with an optional `vis`) are in `e2e/boardApi.ts`.
- **Board thresholds, legends and stat tiles** (`board-thresholds.spec.ts`, plan #64 Part B B.3,
  all three engines, on the http-mode BFF and the fake, in the `gauge-range` transcript's window
  2026-01-01 00:00–01:00 UTC; each test deletes its board): **`e2e:board-thresholds-legend`** (a
  line panel's legend table with mean, max and last and their threshold states; a row isolates its
  series; a 4-row panel's compact legend reached by keyboard opens the full table and Escape returns
  focus; Legend Hidden and a threshold edit survive save and reload, stored as `schema_version` 3 (board spec v3, #173);
  an unparsable value blocks the save with no `PUT`) and **`e2e:board-stat-tile`** (the state chip
  and threshold text of a stat with thresholds; canvas pixels in the sparkline band of a range stat,
  none for a scalar stat). `e2e:a11y-rooms` adds `b-1 view, legend and stat chip`, `b-1 edit,
  compact legend table` and `b-1 edit, thresholds`.
- **Board bar charts** (`panels-categorical.spec.ts`, #173 Part 3b, T22 §10.3, all three engines, on
  the http-mode BFF and the fake, in the same 2026-01-01 00:00–01:00 UTC window; boards through
  `e2e/boardApi.ts`, whose `PanelInput.vis` takes `options`; each test deletes its board). The
  `bars-*` transcripts (`bars-by-version`, `bars-by-version-base` for the window one day earlier,
  `bars-warn`, `bars-trunc`, `bars-keys`, `bars-many`; listed in `transcripts_test.go`) answer
  `POST /api/v1/query_range` by `query`, with samples at 00:00, 00:30 and 01:00 (on every step's
  grid). "Bar i" is band i of the frame's `data-plot` in draw order; a probe reads the canvas pixel
  at the band centre, at 25 % of the bar's length, and `data-value-axis` (`min,max,manual|auto`)
  gives the value scale. **`e2e:categorical-coverage`** (the meter's `100 %`, `limited (1 warning)`
  and its popover, `truncated` and Narrow to Explore with `vis=barchart`), **`e2e:bars-bounds`**
  (fixed `min`/`max` through a reload, `5 values outside the fixed range`), **`e2e:bars-filter`**
  (a click toggles `f=version=…` and the chip, with no new range request: interim until #193),
  **`e2e:bars-inspect`** (the Inspector's value, labels, Explore chip and the disabled Label
  filter), **`e2e:categorical-interactions`** (the listbox keys, the Shift brush across panels,
  Escape, Enter, the tooltip lines and the baseline ghost: the request one day earlier and a
  `text-muted` pixel at the baseline), **`e2e:selection-empty`** (bars in their
  `series-{1 + seriesColourIndex(key)}` colours, a pointer brush dims the other panel's
  unselected bars, Escape restores them; `seriesColourIndex` is imported from the CSS-free
  `engine/canvas2d/seriesColour.ts`), **`e2e:selection-keys`** (a bar and a line panel's legend
  Select share one selection by key) and **`e2e:categorical-table-view`** (`bars_many`: the cap of
  42 at a 588–602 px plot, the table's rows and the CSV export).
- **Board event markers** (`board-events.spec.ts`, #64 Part C, all three engines, on the http-mode
  BFF, Postgres and the fake, in the same window; the tests run one at a time because annotations
  are the organisation's, and each deletes its board and annotations): **`e2e:board-event-markers`**,
  E10 (a deploy at 00:15, a config change at 00:30 and a note at 00:45 show as three
  `[data-event-hit]` targets on the line panel with their labels, evenly spaced on `data-event-x`;
  one at 23:00 the day before does not; the stat tile has none; the summary label ends
  `Events in view: 3.`), E11 (opened on 00:00 – 01:00 with three markers; the time picker then widens the
  open board to 2025-12-31 22:30 – 01:00, a window that still holds the fake's samples, and the line
  panel shows four markers, the 23:00 one first; after the API deletes it, Refresh now shows the
  other three) and E12 (Tab from the panel menu reaches the first marker, whose tooltip reads
  `Deploy · v2.31 · …`). The annotations API helpers are in `e2e/annotationApi.ts`.
  `e2e:a11y-rooms` adds `board with markers` (dark and light, on the http-mode BFF: a chip of two
  markers, no serious or critical axe violation).
- **Board panels on the stub** (plan #64 A.3, A.5): `e2e:a11y-rooms` adds the states `b-1 edit,
  PromQL editor`, `b-1 edit, metric picker open`, `b-1 edit, partial data popover` and `b-1 view,
  panel error`; `e2e:keyboard-only-rooms` operates the panel menu's Duplicate, Remove and Open in
  Explore, and in the panel editor the picker, the PromQL editor and its Run keys, Run query, and
  Escape to Run query then to close; `e2e:lazy-load` checks that a board loads the editor chunk
  once (its panels read the query shape through the language module); `e2e:csp-violations` opens
  the board panel editor with the completion popup and the picker. On b-1 at 1440 × 900 only
  Request rate and Error ratio are on screen: Request latency, below the fold, does not query
  (T07-012), so the board specs wait for two drawn charts.
- **Board LogQL panels** (`board-logql.spec.ts`, plan #67 §5.3, all three engines, on the http-mode
  BFF and the fake, at 1920 × 1080 in the log transcripts' window 2026-01-01 12:00–13:00 UTC; the
  requests are read in the browser; each test deletes its board): **`e2e:board-logql-save`** (a
  PromQL, a LogQL stream and a LogQL Bars panel typed into the panel editor; before and after save
  and reload: saved vis `auto, auto, bars`, a line, six log lines and the volume's summary; the
  volume's `width_px` gives the 5 s step), **`e2e:board-logql-brush`** (a right drag 12:20–12:25 on
  the volume panel sets the board window; one PromQL range, one stream page (`limit` 1 000), one
  kind probe (`limit` 1) and one volume request for it; the stream lists `checkout line D` and `C`)
  and **`e2e:board-logql-paging`** (a full-width stream panel sends one page and no more until
  scrolled; the wheel reaches **End of results** with one more page, sent with its `cursor`; the
  last row is `paging line 1499` of 1 500). The kind probe is answered by the transcript
  `e2e/transcripts/board-logs-probe-checkout.json` (`{app="checkout"}` with upstream `limit` 2, any
  window: `checkout line D` at 12:24, inside both windows, since the BFF refuses an upstream entry outside the request window), listed in `TestE2ETranscripts`; the other requests by the
  Explore › Logs transcripts. On the stub, `e2e:a11y-rooms` adds `b-1 view, log panel` (the 30 stub
  lines in `Log lines: Errors`), `b-1 edit, log panel editor on bars` (not in Firefox, whose page crashes inside axe with that editor open) and `b-1 edit, log panel as bars` (after Done), `e2e:csp-violations` toggles a
  board log panel's Wrap lines, and the keyboard loop L34 operates the order options, Wrap lines
  and the `Log lines` region of `Errors` and `Edge errors` on the board, at full screen, in the
  editor's preview and on a copy, before L24's drains run.
- **Text widget** (`widgets.spec.ts`, #198 Part 3b, all three engines, on the http-mode BFF; each
  test deletes its boards): **`e2e:widget-text`**, **`e2e:widget-text-xss`** (a) the T24 row input,
  (b) the whole XSS corpus, one case per fresh context on its own board against the committed load
  baseline `e2e/fixtures/board-load-baseline.<project>.json` and the generated case list, with the
  exact CSP header and a Trusted Types canary (7 to 11 minutes per engine, four cases at a time;
  its own 15-minute test timeout), (c) the canaries c1–c12 (c8 report-only, Firefox), c15 and c16, and **`e2e:widget-a11y`** (Text). The
  request and violation watch is `e2e/loadWatch.ts` ([the widgets page](../client/widgets.md#the-load-watch-e2eloadwatchts)).
  `BASELINE_UPDATE=1` makes the corpus test rewrite its engine's baseline from the twin board: run
  it in each engine and review the diff. After a corpus change run `npm run gen:xss-e2e-cases`.
- **Widget gallery goldens** (`widget-gallery.spec.ts`, Chromium only): **`golden:widget-gallery`**,
  the gallery's `widget-text` and `widget-text-removals` pages in dark, light and greyscale, at
  1440 × 1400. Generate the baselines with `PW_UPDATE_GOLDENS=1` in the pinned e2e container
  (the same Ubuntu, Node and Playwright browsers as CI) and inspect them before committing.
- **`bench:text-widget-render`** (`perf-text-render.spec.ts`, Chromium only, the stub build): the
  uncached Markdown render per size bucket, the long tasks and the event latency of a six-panel
  Text board; report-only, `LONG_TASK_GATE=enforce` fails a miss ([the widgets page](../client/widgets.md#render-measures-and-the-bench)).
- **`e2e:bff-http-shell`** (`bff-http.spec.ts`, `dev-proxy.spec.ts`): on the http build, `/` opens
  `/t/demo/boards`; About shows `Server version 0.1.0-e2e`; there is no Sign out item; the sidebar
  shows `Data source: demo · Connected`, and the fake lists at least one completed
  `/api/v1/status/runtimeinfo` request answered by the `runtimeinfo` transcript (T06-025); no
  console errors. Through the dev server, About shows
  the same version.

## CI

`.github/workflows/client.yml` runs on pull requests that touch `client/`, `design/tokens.toml`,
`engine/fixtures/`, `engine/crates/dash-tokens/src/tokens.rs` (both checked by `npm test` and
`tokens -- --check`), `server/`, `api/`, `tools/e2e/`, `wire/` (the shared fixtures), `dev/pulsus-fake.*`, `Makefile` or the workflow (opened, synchronised, reopened, and
labelled, so adding `golden-update` reruns it), and on pushes to `main`. Actions are pinned by commit SHA, the token is read-only and
no secrets are used.

| Job | Steps (gate) |
|---|---|
| `check` | `npm ci` (`ci:lockfile` install) → `check:lockfile` (`ci:lockfile`) → `lint` (`ci:lint-ts`) → `typecheck` (`ci:typecheck`) → `tokens -- --check` and `token-lint` (`ci:token-lint`) → `test` (unit) → `build` (with `VITE_GIT_SHA`) → `size` (`ci:bundle-size`, stub build) → an `http` build into `dist-http/` whose manifest must not contain `src/dev/` (the chart gallery is absent from `http` builds) → `size -- dist-http` (`ci:bundle-size`, http build) → `origins` (`ci:dep-audit`, build origins) → `audit` (`ci:dep-audit`, `ci:npm-audit`) |
| `e2e-deps` | beside `check` (no `needs`), one job per engine with a 50-minute timeout: fills the browser cache once, before that engine's shards start. `npm ci`, the Playwright version, then `actions/cache/restore` with `lookup-only: true` of `$RUNNER_TEMP/pw-browsers` (the `PLAYWRIGHT_BROWSERS_PATH`) and `$RUNNER_TEMP/pw-apt` (the browser's system packages as `.deb` files) under the key `pw-<engine>-<version>-ubuntu-24.04-v1`. On a hit it stops there (under 2 minutes). On a miss it runs `playwright install-deps <engine>` (bounded, see below), copies apt's downloaded packages to `pw-apt`, runs `playwright install <engine>` and saves the cache with `actions/cache/save`. A cold install takes 1–8 minutes (an earlier figure of about 30 minutes was an `apt-get update` mirror stall, now bounded). The key changes with the Playwright version; `v1` is a manual bust (raise it to `v2` to rebuild the cache, for example after a runner image change). There is no date in the key, so the cache stays warm until GitHub evicts it (7 days unused) |
| `e2e` | after `check` and `e2e-deps`, fifteen jobs: each engine (`chromium`, `firefox`, `webkit`) × each shard (`kbd-a`, `kbd-b`, `kbd-c`, `rest`, `rest-b`, [below](#e2e-shards)), with a PostgreSQL 16.16 service on port 55432 and a 50-minute timeout (`E2E_TIMEOUTS.jobMin`, [below](#e2e-timeouts)): `npm ci`, Go 1.27.4 and its toolchain check, the Playwright version, `actions/cache/restore` of e2e-deps' cache under the same key with `fail-on-cache-miss: true` (a shard never installs a browser cold, and never saves), `playwright install-deps <engine>` from the cached packages (copied into `/var/cache/apt/archives/`, so apt fetches only what changed since the cache was made; each attempt is bounded to 8 minutes and tried up to three times, because its `apt-get update` once stalled on a mirror for 38 minutes, while a normal attempt takes under 2), `playwright install <engine>` (already present), `e2e database` (applies `server/deploy/postgres-roles.sql` and creates `pulsus_e2e`), `make e2e-build`, `npm run e2e -- --project=<engine>` with `E2E_SHARD=<shard>`, `E2E_PG_APP_URL` and `E2E_PG_OWNER_URL` (`PW_UPDATE_GOLDENS=1` only on Chromium's `rest` shard with the `golden-update` label); `blob-report/` and `test-results/` are uploaded as `e2e-<engine>-<shard>` for 14 days, and Chromium's `rest` shard also uploads `e2e/__screenshots__/` as `e2e-screenshots`. Golden and bench specs run on Chromium only. On CI Playwright runs two workers with a 35-minute `globalTimeout` (`E2E_TIMEOUTS.globalMin`), so an overrun fails the run with its artefacts before the job's timeout. CI retries a failed test once, except the keyboard parts (`retries: 0` in their `describe`): the traversal is deterministic, so a retry would only hide a failure. **`e2e-deps` failure scope:** `needs: e2e-deps` waits for the whole matrix job, so if any engine's leg fails, all fifteen `e2e` jobs are skipped, also those of the engines whose cache filled (a matrix leg cannot be a `needs` target; isolating each engine would take three copies of the job). Every `e2e-report` still runs and fails, so nothing passes unchecked: its merge step stops at `cp: cannot stat 'shards/*/blob-report/*.zip'` (no shard uploaded), `ci:e2e-complete` exits 2 with `error[input] cannot read ran/*.json`, and the merged coverage reports `keyboard-part-missing` for every part. Recovery: "Re-run failed jobs" reruns the failed leg and the skipped jobs; `fail-fast: false` let the other legs save their caches, so they hit. A leg fails only when `install-deps` fails three bounded attempts |
| `e2e-report` | after all fifteen `e2e` jobs, even when one failed (not when the run is cancelled), one job per engine with a 10-minute timeout: `npm ci`; download that engine's five artefacts into `client/shards/`; `playwright merge-reports` of the five blobs into one HTML report, and of each shard's blob into `ran/<shard>.json`; **`ci:e2e-complete`** (`playwright test --list --reporter=json --project=<engine>` into `listed.json`, which starts no web server, then `npm run e2e:complete -- listed.json <engine> ran/*.json`); **`e2e:a11y-rooms` (merged keyboard coverage)**, `npm run e2e:keyboard-coverage -- shards <engine>`; the merged HTML report is uploaded as `e2e-report-<engine>` for 14 days. A shard job that died before its upload shows as `e2e-test-missing` for each of its tests, and a failed keyboard part as `e2e-test-failed` and `keyboard-part-missing` |

### E2E shards

Each engine's suite runs as five jobs (`client/config/e2eShards.ts`, read from `E2E_SHARD` in
`playwright.config.ts`): three pick keyboard parts by tag, `rest-b` picks whole spec files, and `rest`
takes the remainder. Playwright matches `grep` against `<project> <file> <describe>… <title>
<tags>`, so a file of `REST_B_FILES` is matched as a whole space-separated token (`a<file>` is not
`<file>`). The five filters partition the suite, and `ci:e2e-complete` checks that every listed
test is in exactly one of them (a retried test is still one test).

| Shard | Filter | Tests |
|---|---|---|
| `kbd-a` | `grep /@kbd-a(?![\w-])/` | K1 and K2, in parallel |
| `kbd-b` | `grep /@kbd-b(?![\w-])/` | K3 alone |
| `kbd-c` | `grep /@kbd-c(?![\w-])/` | K4 and K7, in parallel |
| `rest` | `grepInvert` of the `kbd` tags and the `REST_B_FILES` | K5, `golden-gallery.spec.ts`, the Chromium-only specs and every spec file not in `REST_B_FILES` |
| `rest-b` | `grep` of the `REST_B_FILES`, `grepInvert` of the `kbd` tags | the spec files of `REST_B_FILES` |

**Choosing `REST_B_FILES`:** from the webkit `rest` JSON report of a CI run (`playwright
merge-reports --reporter=json` of its blob), sum each spec file's test durations
(`results[].duration`), leaving out `keyboard.spec.ts` and `golden-gallery.spec.ts` (the goldens
stay in `rest`). Start `rest` at K5's duration plus `golden-gallery.spec.ts`'s and `rest-b` at 0;
take the files longest first (ties by path) and give each to the shard with the smaller total
(a tie goes to `rest-b`). The list is sorted and holds only real `*.spec.ts` files of `e2e/` (unit
test `e2eShards.test.ts`). The current list comes from run 45285529104, where K5 alone (1 060 s)
outweighed every other file together (866 s), so every one of them is in `rest-b`. A new spec file
runs in `rest` until it is added.

K3 runs alone because two long parts in one job contend for its four vCPUs (K3 and K4 together hit
the old 20-minute part timeout in drains). K4 was split from K7 at the L24/L25 boundary for the same
reason (#130 plan 6); `K6` is kept for a split of K3.

#### E2E timeouts

`E2E_TIMEOUTS` in `client/config/e2eShards.ts`, in minutes:

| Limit | Value | Where |
|---|---|---|
| A keyboard part | 30 (`partMin`) | `test.setTimeout` in `e2e/keyboard.spec.ts` |
| A shard run | 35 (`globalMin`) | Playwright's `globalTimeout` on CI (`playwright.config.ts`) |
| The `e2e` job | 50 (`jobMin`) | `timeout-minutes` of the `e2e` job (`client.yml`) |
| Setup before the test step | ≤ 13 (`setupMaxMin`) | checkout, `npm ci`, Go, the cache restore and `make e2e-build` (≤ 3 observed), plus one stalled `install-deps` attempt (8) and its retry |
| Tail after it | ≤ 2 (`tailMin`) | the uploads and post-job steps (seconds observed) |

The unit test `e2eShards.test.ts` checks part < global, setup + global + tail ≤ job, that the
workflow's value equals `jobMin`, and that the spec and the config read these constants. The
margins are wide because firefox varies by up to 1.5× between runs of one head (one keyboard part
took 16.1–24.0 minutes over six runs).

**The timing rule:** times are recorded, not gated. A slow but green job is reported, not acted
on; only a real timeout acts. **Fallback:** if a keyboard part hits its 30-minute timeout, split K7
into K7 `toolbar (L25)` and K8 `edit layout (L26)` (both `@kbd @kbd-c`, K8 right after K7 in
`SINGLE_TEST_ORDER`), and move K4 to `@kbd-b` beside K3. Add K8 to `KEYBOARD_PARTS`, widen
`partOfTitle` to `K[1-8]`, start `DRAIN_SKIP.K8` at `[]`, run once so K8 has part files, then apply
the [drain-skip rules](../client/README.md#keyboard-coverage) (including the redundant-drain rule)
from that run's files. A part that then times out again is a failure to report. No branch
protection names the job names, so a change of the matrix needs no settings change.

The end-to-end jobs need the browsers' system libraries, which `playwright install-deps` installs on
the CI image. On a workstation without them, install the packages Playwright names, or run only the
engines whose libraries are present.

## Engine

The Rust chart engine is the Cargo workspace `engine/` ([the engine page](../client/engine.md),
issue #68). Every engine gate runs in one pinned image, `engine/ci/lavapipe.Dockerfile`, both in CI
and through `make`.

### Engine toolchain and image pins

`engine/tools.toml` holds every pin; the Dockerfile must carry the same literals and the toolchain
file the same channel (`cargo xtask spec-lint` fails otherwise).

| Pin | Value |
|---|---|
| Base image | `docker.io/library/ubuntu:noble-20261110` by index digest (`[golden] image`) |
| Apt snapshot | `20261115T000000Z` on snapshot.ubuntu.com (`apt_snapshot`): every package resolves to the same build |
| lavapipe | `mesa-vulkan-drivers=25.2.8-0ubuntu0.24.04.4` (`mesa`; the golden tests assert `Mesa 25.2.8`, `mesa_upstream`) |
| LLVM | `libllvm20` `1:20.1.2-0ubuntu1~24.04.3` (`llvm`; asserted, not requested) |
| Vulkan loader | `libvulkan1=1.3.275.0-1build1` (`vulkan_loader`) |
| CA store | `ca-certificates=20240203` from the frozen noble release pocket (`ca_certificates`): the base image has none and the snapshot is HTTPS only |
| Rust | `1.98.0` (`rust`; also `engine/rust-toolchain.toml` with rustfmt, clippy and the wasm32 target) |
| rustup-init | `1.29.3`, verified by sha256 (`rustup`, `rustup_sha256`) |
| cargo-nextest, cargo-deny | `0.9.152`, `0.20.2` |

`VK_ICD_FILENAMES` selects the lavapipe ICD (`lvp_icd.json`). A change to any pin is one PR that
edits `tools.toml` and the Dockerfile together and carries the `golden-update` label (T05-004).

### Engine dependencies

- Every crate in `engine/Cargo.toml` `[workspace.dependencies]` is pinned exactly (`=x.y.z`) and
  `engine/Cargo.lock` is committed; every build uses `--locked`. A release younger than 7 days is
  not adopted (the T18 §4.11 rule), and any change to the locked set is a reviewed dependency PR.
- `cargo deny check licenses advisories bans sources` (`engine/deny.toml`, `ci:dep-audit` engine
  leg) allows exactly MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD and MPL-2.0, with three
  exact-version exceptions: `unicode-ident@1.0.27` (Unicode-3.0), `foldhash@0.2.0` and
  `slotmap@1.1.1` (Zlib); yanked crates, unknown registries and git sources are denied; duplicate
  versions warn (today `hashbrown`, `miniz_oxide`, `syn`).
- Workspace lints deny `unwrap_used`, `expect_used`, `dbg_macro`, `todo` and `disallowed_types`;
  `engine/clippy.toml` disallows `std::sync::Mutex` and `RwLock` (T03-008, `ci:engine-lint`).

### Engine make targets

Run from the repository root. They need Docker or Podman (`DOCKER=podman`; rootless Podman keeps
file ownership with `ENGINE_RUN_FLAGS=--userns=keep-id`). The image keeps its build in
`engine/target/image`.

| Target | What it runs | Gate |
|---|---|---|
| `make engine-image` | `docker build -f engine/ci/lavapipe.Dockerfile -t pulsus-engine-ci:local engine/ci` | — |
| `make engine-test` | `cargo nextest run --workspace --exclude dash-golden --locked` | `unit:*` |
| `make engine-lint` | `cargo fmt --all --check`, `cargo clippy --workspace --all-targets --locked -- -D warnings`, `cargo xtask spec-lint`, `cargo deny --locked check …` | `ci:engine-lint`, `ci:spec-lint`, `ci:dep-audit` |
| `make engine-goldens` | `cargo test -p dash-golden --release --locked golden_` | `golden:gallery`, `golden:engine-overlay`, `golden:decimation-raw`, `golden:decimation-ref`, `golden:extreme-range` |
| `make engine-goldens-update` | the same with `GOLDEN_UPDATE=1`, writing `engine/crates/dash-golden/goldens/*.png` | — |

Outside the image, `cargo test --workspace` in `engine/` runs everything on the host's lavapipe;
`golden_gallery` then fails its pinned-Mesa assertion by design.

### The engine in the browser (Part C1)

The browser engine needs a second image, `engine/ci/web.Dockerfile`, built on the lavapipe image
(`--build-arg BASE`). It copies nothing; every literal equals `engine/tools.toml` `[web]`
(`cargo xtask spec-lint`): the nightly `nightly-2026-11-15` with `rust-src` and wasm32 (the threaded
build needs `build-std`), `wasm-bindgen-cli` 0.2.130 (equal to `Cargo.lock`), binaryen
`version_133`, Node 24.22.3 and Go 1.27.4 (each verified by sha256), and Playwright 1.65.0's
Chromium, whose system packages come from the same apt snapshot, so Mesa stays at its pin. It sets
`ENGINE_IN_IMAGE=1`; outside it, each target below re-runs itself in the image (host network, the
repository at `/w`, git's common directory mounted where a worktree's `.git` file points).

| Target | What it runs | Gate |
|---|---|---|
| `make engine-web-image` | builds `pulsus-engine-web:local` (after `make engine-image`) | — |
| `make engine-wasm` | `cargo xtask build-wasm` into the git-ignored `client/src/engine/wasm/gen/`; `make build` (so `make e2e-build`) needs it | — |
| `make engine-wasm-check` | two builds from separate target directories, byte-equal; the generated `dash_core_mt.d.ts` equal to the committed one; `cargo xtask gen-layout --check` | `ci:engine-gen` |
| `make engine-wasm-probe` | `cargo xtask build-wasm --probe`: the engine with the `probe` feature (`engine_probe_input`, `engine_probe_ring_start`; `engine_probe_freeze` and `engine_probe_unfreeze`, plan #68 C2b; `engine_probe_synth` and `engine_probe_chunk`, plan #68 C2d1) into the git-ignored `client/src/engine/wasm/gen-probe/` (plan #68 C2a1) | — |
| `make e2e-build-release` | `make build API_MODE=stub VERSION=0.1.0-e2e CLIENT_OUT=dist-release` with no `VITE_ENGINE` and no faults into `client/dist-release` and `build/e2e-release/pulsus-dash` (served by `tools/e2e/serve.sh release PORT`), then `probe-absent.ts client/dist-release`: the unflagged signed-asset build of the default legs (plan #256) | `ci:probe-absent` |
| `make e2e-build-probe` | after `make engine-wasm-probe`: `VITE_ENGINE_FAULTS=1 VITE_ENGINE_PROBE=1 make build API_MODE=stub CLIENT_OUT=dist-probe` (Vite resolves `virtual:dash-engine` to `gen-probe/`) into `client/dist-probe` and `build/e2e-probe/pulsus-dash`, then `probe-absent.ts --expect-faults --expect-probe client/dist-probe` | `ci:probe-absent` (probe tree) |
| `make engine-gpu-smoke` | per engine e2e project, the adapter headless Chromium sees and whether it renders | — |
| `make engine-bench` | the frame benches (plan #68 C2d1), report-only: a PostgreSQL 16 as for `make engine-e2e` (compose project `pulsus-engine-bench`, port 57534; `E2E_PG_APP_URL` and `E2E_PG_OWNER_URL` set by the caller skip it), then in the image: the PulsusDB fake, `make e2e-build-probe` and `ENGINE_BENCH=1 playwright test -c playwright.engine.config.ts --project bench`; results in `client/test-results/bench/` ([below](#frame-benches)) | `bench:frame-gallery`, `bench:frame-line-1e8` (report-only) |
| `make engine-e2e` | a PostgreSQL 16 (the compose `pg16` service in project `pulsus-engine-e2e`, port 57532, taken down on exit; `E2E_PG_APP_URL` and `E2E_PG_OWNER_URL` set by the caller skip it), then in the image: the fault build for the e2e BFFs (`VITE_ENGINE_FAULTS=1 make e2e-build`) and `probe-absent.ts --expect-faults dist`; clean `dist-release-stub` and `dist-release-http` builds, `npm run size` on each, `check-bundle-modules.ts` on both, and `probe-absent.ts` on each; `make e2e-build-probe`; `make e2e-build-release`; `dash-golden` built; `playwright test -c playwright.engine.config.ts` | `ci:probe-absent`, `ci:bundle-size` (engine row), `e2e:mode-matrix`, `golden:engine-line`, `canvas2d parity`, `e2e:engine-recovery`, `e2e:csp-violations` (engine), `e2e:shim-fuzz`, `e2e:engine-camera`, `e2e:engine-hover`, `e2e:engine-layer`, `e2e:engine-selection`, `e2e:selection-sources` (engine leg), `bench:shim-input-cost` (report-only) |

**Projects.** `lavapipe` (gated): `--use-angle=vulkan --enable-features=Vulkan --use-vulkan=native
--ignore-gpu-blocklist --disable-vulkan-surface`, WebGL2 through ANGLE on lavapipe.
`swiftshader`: `--enable-unsafe-webgpu --enable-unsafe-swiftshader
--use-webgpu-adapter=swiftshader`, WebGPU on Dawn's CPU adapter (Dawn lists no lavapipe adapter).
SwiftShader cannot render in the pinned image (`onSubmittedWorkDone` and `mapAsync` reject), so
`client/e2e/engine-legs.json` (`{"webgpu": "report", "reason": …}`) makes the `swiftshader`
project's failures soft; the run, `make engine-e2e` and `make engine-gpu-smoke` print
`WebGPU leg report-only: <reason>`. Remove the file when the leg renders. Real-GPU WebGPU is a
hardware-runner follow-up. `probe` (plan #68 C2a1): the `lavapipe` flags against the probe build's
BFF (`tools/e2e/serve.sh probe 4175`), `e2e/engine-shim-fuzz.spec.ts` and `e2e:engine-hover` H1b
(plan #68 C2b: it freezes a frame at one presentation, a probe-build hook); the other two projects
skip the fuzz and H1b, and every other spec and golden runs on the fault build (release wasm).
`e2e:engine-hover` H1–H6 and `e2e:engine-layer` L1–L5 (plan #68 C2c1: threshold lines and event
lines on probe frames) run like `e2e:engine-camera`: `lavapipe` gated, `swiftshader` report-only.
So does `e2e:engine-selection` (plan #68 C2c2: the selection on probe frames, with `frame2d`
Canvas 2D frames for S10 and S1c), except S11, which needs the probe build's `renew()` and runs in
`probe`. The engine leg of `e2e:selection-sources` (`inspector.spec.ts`) runs on `lavapipe` against
the http-mode BFF, which the engine config starts too (`tools/e2e/serve.sh http 4174`).

**Default legs (plan #256).** The engine is the default renderer
([ADR-0031](../../designs/adr/0031-gpu-engine-default-renderer.md)); the fault build (4173) is
pinned to Canvas 2D like every `make e2e-build`, so its engine specs pass `engine=wasm`. Three more
servers carry `e2e:mode-matrix`'s default legs, none reused: the unflagged release BFF
(`tools/e2e/serve.sh release 4176`, `make e2e-build-release`, its signed manifest) for M1 (the
engine with no flag, both projects), M2 (a board's line panel on the engine, its stat on Canvas 2D),
M3 (`?engine=canvas2d`) and M5–M12 (no OffscreenCanvas, `mode=static`, `st`, `mtr`, not
cross-origin isolated, no GPU API, no `Atomics.waitAsync`, a failed session: each Canvas 2D with no
engine request); `npx --no-install vite preview --outDir dist-release-stub --port 4177` (the computed
manifest) for M13 (the manifest lists the wasm; the engine draws) and M14 (a flipped wasm byte is
refused twice, then Canvas 2D); and the dev server `npx --no-install vite --port 5175` with
`VITE_API_MODE=stub` and no `VITE_ENGINE` for M15 (the engine draws). On the fault build M4 checks
the pin (Canvas 2D, no engine request), and the integrity leg reloads after the failed boot: Canvas
2D with no engine request, because the boot failure marked the session.

**Goldens in the browser.** `golden:engine-line` compares the browser engine's canvas
(`&engine=wasm&mode=t2`, status 2, llvmpipe) with `dash-golden render` of the same page, theme, CSS
size and DPR: both images `round(css × dpr)`, `compare --max 0.001 --tile-max 0.05`. Since plan
#68 C2b it also compares `line-50` dark hovered at the plot's centre and with a box band (a right
drag over 20–40 % of the plot) against `dash-golden render … --hover X,Y` and `--box X0,X` (canvas
CSS px: the native render draws the engine's overlay for that pointer and band). The native
`golden:engine-overlay` (in `make engine-goldens`) checks the same overlay on `line-50` dark and
light at 1118 × 240 against `goldens/line-50-{dark,light}-overlay.png`, T1 vs T2 within mean ꟻLIP
0.001. Since plan #68 C2c1 both add the layer pages `line-thresholds` and `line-events` (dark and
light; `goldens/line-{thresholds,events}-{dark,light}.png`): `dash-golden render --page
line-thresholds` draws the `engine/fixtures/layer.json` case of that id (its spec JSON, series and
event times), without `--value-range`, `--hover` or `--box`. Since plan #68 C2c2,
`dash-golden render --select-keys K,… --select-interval A,B` draws a gallery page with the page
selection (16-hex series keys; the interval in ms): `golden:engine-overlay` adds
`goldens/line-50-selection-{dark,light}.png` (series 3 selected, 12:10–12:20), and
`e2e:engine-selection` S7 compares a probe frame of `line-50`'s series with it. The `dash-marks` GPU
tests (`selection_passes`, `tier_parity`, …) need `--features gpu`: `cargo nextest run -p
dash-marks --features gpu` in the engine image (`make engine-test` does not enable it). `canvas2d
parity` is sampled geometric parity with Canvas 2D (equal plot rects, a sampled line mask); the two
renderers anti-alias differently by design.

**`ci:probe-absent`.** `node scripts/probe-absent.ts [--expect-faults] [--expect-probe] <dist>`
scans every file of the tree, recursively: `__dashProbe` or `__pulsus_engine_fault__` in a release
tree is `probe-in-release`; with `--expect-faults` each of the three fault sites
(`__pulsus_engine_fault__:route|boot|worker`) missing is `fault-site-missing`. The probe engine's
exports `engine_probe_input` and `engine_probe_synth` (plan #68 C2d1) in any `.wasm` are one
`probe-in-release` each in every tree (the fault build's included) unless `--expect-probe`, which
requires each instead (`probe-missing`).

#### Frame benches

`bench:frame-gallery` and `bench:frame-line-1e8` (plan #68 C2d1, T05 §4.3) measure presented
frames during scripted interaction. They are report-only until the reference lab exists: no budget
fails a run. They run in project `bench` of `client/playwright.engine.config.ts`, which exists only
with `ENGINE_BENCH=1`, so `make engine-e2e` never runs them. With `ENGINE_BENCH=1` the config
starts only the fake (4190) and the probe BFF (4175). The project uses the lavapipe flags, the
probe build and one worker. `make engine-bench` takes about 25 minutes plus the builds on the
gate host; the worst case, every case running to its box, is about 60 minutes.

The script is an open loop: one step per main-thread frame, whatever the engine presents. When
the engine is slower, the input ring coalesces records (T03-020), so a case can present far fewer
frames than it has steps; `steps` and `coalescing` record that. After the script the harness
keeps collecting until the frame has presented twice or the case's box runs out: 60 s for a
gallery case, 120 s for a 10⁸ case. A case that runs out is recorded `timedOut`; that is a
figure, not a failure.

- **`bench:frame-gallery`** (`e2e/bench-frame-gallery.spec.ts`) covers every gallery page the
  engine draws: `line-1`, `line-50`, `line-gaps`, `line-600`, `line-thresholds`, `line-extreme`
  and `line-events`. It runs three legs:
  - `wasm-webgl2`: `&engine=wasm&mode=t2`;
  - `wasm-webgpu`: a SwiftShader Chromium. It is recorded `skipped: 'leg-unavailable'` while
    `e2e/engine-legs.json` makes that leg report-only, or when the frame is not on WebGPU;
  - `canvas2d`: `&engine=canvas2d`, the baseline on the same host.

  Each page runs the zoom-pan-zoom script as case `<page>` and the hover sweep as `<page>-hover`.
  Each case opens a fresh page.
- **`bench:frame-line-1e8`** (`e2e/bench-frame-line-1e8.spec.ts`) uses a 1118×240 probe frame.
  The probe's `synth` gives it F1c: 1 000 series × 10⁵ grid points over 0–10⁶ ms, built in the
  worker. Its cases are:
  - `1e8`: the script;
  - `1e8-selected`: series 7 selected (m = 1);
  - `1e8-selected-500`: 500 keys (m = 500, #264);
  - `1e8-hover`: the hover sweep.

  The synthesis outcome decides what happens next, the first match winning:
  - `ok: false` from the worker (its allocation failed): each case left is recorded
    `skipped: 'memory'`, the page reloads for a fresh worker, and the cases run at 10⁷
    (1 000 × 10⁴) as `1e7-…`;
  - a `fatal`: the run fails;
  - no answer within 120 s, or a worker restart: the case is `timedOut`, the page reloads and the
    next case runs.

  After an `ok` it waits, inside the case's box, for the summary of the synthesised series (the
  chunk is not an input-ring record, so `settle` does not see it). A case that times out also
  reloads before the next one. After a slow 10⁸ frame the GPU process can still be busy, and the
  reloaded engine can miss its 10 s boot. The bench then retries the boot up to 6 times, 20 s
  apart, and records the case `timedOut` if it never boots.

  Its other tests:
  - **B3** checks `synth`'s acknowledgements: two equal ones, then `ok: false` (`reason: 'alloc'`)
    for an impossible size, after which the probe's `chunk(n)` still reports 10 × 1 000.
  - **B4** (`attribution`) checks the frame-id filter on its own, before the measured cases. A
    small noise frame redraws every 100 ms and presents, while a drive of the idle bench frame
    collects nothing.
  - **`synth outcomes`** drives the precedence above with the probe's `synthFault` on small
    sizes: `alloc`, `silent` (a 3 s timeout) and `fatal`.

**Fields.** Each result in `client/test-results/bench/bench-frame-gallery.json` and
`bench-frame-line-1e8.json` (JSON arrays, appended per test) is a `BenchResult`
(`client/scripts/lib/benchStats.ts`):

| Field | What |
|---|---|
| `gate`, `case`, `leg` | the gate, the case and `wasm-webgl2`, `wasm-webgpu` or `canvas2d` |
| `points`, `series` | the frame's volume |
| `frames` | `chart-present` marks inside the script's span |
| `intervalMs` | `{p50, p95, p99, max}` (nearest rank) of the intervals between consecutive marks: the frame time |
| `drawMs` | the same of the `chart-draw` measures ending in the span: the draw time |
| `over1`, `over2` | intervals over 16.7 ms and over 33.4 ms (one and two missed frames) |
| `steps`, `coalescing` | the steps dispatched, and steps per presented frame (`null` with no frame) |
| `hovers` | hover cases: the hover events the frame emitted (gallery: the crosshair's `aria-valuenow` changes; probe: `hovers(n)`) |
| `timedOut` | `true` when the case's box ran out |
| `skipped` | `memory` or `leg-unavailable`; then `frames` is 0 and the percentiles `null` |

An empty percentile (no interval, as with one frame) is `null` in the JSON. Each result is also a
test annotation and a console line, with PRF-001 (p50 interval ≤ 16.7 ms) and PRF-002 (p99 ≤
22.2 ms) marked `ok`, `over`, or `n/a` for an empty percentile.

**Failures.** Only relative sanity checks fail the run, never a per-step count:
- a case whose drive ran did not dispatch every step of its script;
- a case that is neither skipped nor timed out has fewer than 2 presented frames. A timed-out
  drive is still held to the movement checks below; only a case whose box ran out before its
  drive (the synthesis or the selection's settle, as m = 500 at 10⁸) is not checked;
- a script case ends at the window of its first `a11y` (nothing moved);
- a hover case has no hover event, or its crosshair never reached a position other than its one
  before the case. The engine answers only the latest Overlay (C2b), so a slow frame can report a
  single hover;
- a frame fails, the engine reaches status 4 or a `fatal` comes during synthesis, or a frame leaves
  its leg;
- the JSON lacks a case or a field.

The numbers are lavapipe and synthetic input, not the reference device and trusted input
(T05 §7.1).

### Engine CI

`.github/workflows/engine.yml` runs on pull requests that touch `engine/`, `design/tokens.toml`,
`client/scripts/gen-tokens.ts`, `client/scripts/engine-fixtures.ts`, `client/src/i18n/format.ts`,
`client/src/engine/canvas2d/`, `client/src/engine/api.ts`, `client/src/dev/{synth,keyHash,gallery}.ts`
or the workflow (opened, synchronised, reopened, labelled), on pushes to `main`, and nightly at
02:00 UTC. Actions are pinned by commit SHA and no secrets are used.

| Job | Runs (in the image) | Gate |
|---|---|---|
| `image` | builds the image, or restores it from the Actions cache keyed by the sha256 of the Dockerfile and `tools.toml` | — |
| `lint` | `cargo fmt --all --check`; `cargo clippy --workspace --all-targets --locked -- -D warnings`; `cargo xtask spec-lint` | `ci:engine-lint`, `ci:spec-lint` |
| `deny` | `cargo deny --locked check licenses advisories bans sources` | `ci:dep-audit` (engine leg) |
| `test` | `cargo nextest run --workspace --exclude dash-golden --locked` | `unit:*` |
| `goldens` | `cargo test -p dash-golden --release --locked golden_`; nightly also `-- --ignored golden_decimation_` (10⁸ points) | `golden:gallery`, `golden:engine-overlay`, `golden:decimation-raw`, `golden:decimation-ref`, `golden:extreme-range` |

**Engine goldens.** With the `golden-update` label on the PR, the `goldens` job runs with
`GOLDEN_UPDATE=1` and uploads the written PNGs as the `engine-goldens` artefact (14 days); commit
them, review them as images in the PR, remove the label and re-run so the comparison runs. The
parity fixtures are not goldens: they are rewritten with `npm run engine-fixtures -- --write`.

## Server

The server's checks run from the repository root through `Makefile`. What the server does is
described in [the server page](../server/README.md) and [the database page](../server/database.md).

### Server toolchain

| Tool | Version | Where it is fixed |
|---|---|---|
| Go | 1.27.4 | `server/go.mod` (`go 1.27.0`, `toolchain go1.27.4`). CI installs exactly 1.27.4 (`setup-go` `go-version`, because `go-version-file` reads only the `go` line), sets `GOTOOLCHAIN=local` and `GOFLAGS=-mod=readonly`, and fails if `go env GOVERSION` differs from the `toolchain` line. Change both together |
| oapi-codegen, sqlc, govulncheck, go-licenses | v2.8.2, v1.31.1, v1.9.0, v2.0.1 | `tool` directives in `server/go.mod`; run as `go -C server tool <name>` (`make go-licenses` builds go-licenses into `build/bin`) |
| Python | 3.12 or later, standard library only | the `ci:no-pulsusdb-host` checker; CI uses the runner's `python3` |
| golangci-lint | 2.15.0 | `make tools-ci` downloads it into `build/bin` and verifies its sha256 |
| squawk | 2.72.0 | `make tools-ci`, same |
| openapi-typescript | 7.13.0 (with TypeScript 5.9.3) | `tools/api-gen/package.json` and its lockfile |

`tools/api-gen` is a separate npm package because `openapi-typescript` declares a peer dependency on
TypeScript 5, while the client pins TypeScript 6. Its `.npmrc` is a copy of the client's
(`save-exact`, `engine-strict`, `ignore-scripts`). Install it with `npm --prefix tools/api-gen ci`.

Binaries build with `CGO_ENABLED=0`. The test targets set `CGO_ENABLED=1`, because `-race` needs
cgo.

### Make targets

| Target | What it does | Gate |
|---|---|---|
| `make build` | `client-build` (`VITE_API_MODE=$(API_MODE)`, `API_MODE ?= http`, `VITE_GIT_SHA=$(GIT_SHA)`), `assets-pack` (a new signing key in `build/keys/`, then `pack-assets.ts` into `server/internal/gateway/static/dist/`), then `go build -tags embedassets` with the public key into `$(OUT)` (`OUT ?= build/pulsus-dash`); see [Serving the client](../server/README.md#serving-the-client) | build |
| `make e2e-build` | `make build` twice with `VITE_ENGINE=$(E2E_ENGINE)` (`E2E_ENGINE ?= canvas2d`: the main suite's host browsers have uncontrolled GPUs, so its builds pin Canvas 2D; the engine is still built in), `API_MODE=stub` into `build/e2e-stub/pulsus-dash` and `API_MODE=http` into `build/e2e-http/pulsus-dash`, both `VERSION=0.1.0-e2e`; and the PulsusDB fake, `CGO_ENABLED=0 go build -trimpath` of `./cmd/pulsus-fake` into `build/e2e-fake/pulsus-fake` | — |
| `make client-dev` | `make engine-wasm`, then `npm --prefix client run dev` (the dev server refuses to start without the engine) | — |
| `make e2e` | `npm --prefix client run e2e` | `e2e:*` |
| `make server-build` | builds `build/pulsus-dash` without the client (`VERSION ?= 0.1.0-dev`); its `serve` refuses to start unless `--api-only` | — |
| `make api-gen` | regenerates `server/internal/gateway/api/api.gen.go` (oapi-codegen), `server/internal/store/dbgen` (sqlc) and `client/src/api/gen/schema.d.ts` (openapi-typescript) | — |
| `make api-gen-check` | `server/scripts/api-gen-check.sh`, then its self-test `server/scripts/test-api-gen-check.sh` | `ci:api-gen` |
| `make go-mod` | `go mod verify` and `go mod tidy -diff` | `ci:go-mod` |
| `make go-lint` | golangci-lint 2.15.0 with `server/.golangci.yml` (depguard, errcheck, forbidigo, gosec, govet, ineffassign, staticcheck, unused; also over `itest` files), then the depguard self-test `server/scripts/check-depguard-fixture.sh` | `ci:go-lint`, `ci:depguard` |
| `make go-test` | `go test -race ./...` | `ci:go-test` |
| `make govulncheck` | `govulncheck ./...` | `ci:govulncheck` |
| `make migrations-lint` | squawk over `server/migrations/*.sql`, then the failing fixture must fail with `require-concurrent-index-creation` | `ci:migrations` |
| `make itest` | `go test -race -tags itest` against the clusters in `DASH_ITEST_PG_URLS` ([database page](../server/database.md#integration-tests)), with the PulsusDB fake in-process ([testing against PulsusDB](testing-pulsusdb.md)) | `itest:rls-isolation`, `itest:no-extensions`, `itest:migrations`, `itest:promql-range`, `itest:promql-errors`, `itest:cancel`, `itest:cancel-mid-stream`, `itest:tenant-header`, `itest:datasource-check`, `itest:board-find`, `itest:board-tags`, `itest:board-list-snapshot`; `itest:pulsusdb-contract` runs only with `DASH_CONTRACT_PULSUSDB_URL` and is skipped in CI, and `itest:board-tags-old-binary` runs only through `make itest-old-binary` |
| `make itest-old-binary` | `server/scripts/itest-old-binary.sh`: builds the merge-base of `HEAD` with `OLD_BINARY_REF` (default `origin/main`) in a git worktree under `build/old-binary/` (removed on exit), then runs `TestBoardTagsOldBinary` with `DASH_OLD_BINARY` set to that binary; fails unless the test passes (it never skips there). Needs `DASH_ITEST_PG_URLS`. A required local gate for every change to the board schema or spec ([database page](../server/database.md#old-binaries-and-make-itest-old-binary)) | `itest:board-tags-old-binary` |
| `make cpu-instr` | `server/scripts/cpu-instr.sh`: writes the workload bodies first (outside valgrind, so the input is not counted), then runs the BFF workloads W1, W2 and W3 under cachegrind, minus an empty run that reads the same input, against `server/testdata/bench/cpu-instr.json`; more than +3 % fails, and so does a Go or valgrind version other than the baseline's (`rebaseline`). Needs valgrind | `bench:cpu-instr` |
| `make cpu-instr-update` | rewrites the baseline; run it in CI and commit the result with the change that moves it | — |
| `make bench-bff` | the two time budgets `TestBudgetPromqlDecode` and `TestBudgetBffOverhead`: with `REFERENCE_LAB=1` they fail over 30 ms per 10⁶ points, or over 5 ms (p50) and 20 ms (p99) of BFF overhead; without it they skip ([budgets](../server/pulsusdb.md#budgets-t06-7-t05-006)) | `bench:promql-decode`, `bench:bff-overhead` (reference lab) |
| `make go-licenses` | `server/scripts/go-licenses.sh` (licence check and `build/THIRD_PARTY_NOTICES.txt`), then its self-test `server/scripts/check-go-licenses-fixture.sh` | `ci:go-licenses` |
| `make geo-test` | `python3 -I -m unittest discover -s tools/geo -p 'test_*.py'` ([geo data](#geo-data)) | `unit:geo-build`, `unit:geo-gazetteer-build` |
| `make geo-data` | `npm --prefix client run geo-data` | `ci:geo-data` |
| `make geo-check GEO_SRC=<dir>` | `tools/geo/build.py <dir> --check`: rebuilds the geo assets from the pinned sources in `<dir>` and compares them byte for byte (local only; its output goes in a PR that changes an asset) | — |
| `make no-pulsusdb-host` | the checker's self-test, then (only if it passes) the scan of every tracked file; reads `dev/local.env` if present. `ARGS=--show-paths` names the files | `ci:no-pulsusdb-host` |
| `make itest-local`, `make dev-up`, `dev-db`, `dev-migrate`, `dev-down`, `dev-reset` | the dev compose stack ([dev stack page](dev-stack.md)); `itest-local` runs `$(ITEST_GOAL)` (default `itest`; `ITEST_GOAL=itest-old-binary` runs the old-binary test) against its PostgreSQL 15 and 16 | — |
| `make dev-smoke` | `dev/smoke.sh`, then `dev/smoke-selftest.sh` ([dev stack page](dev-stack.md#smoke-test-cidev-stack)) | `ci:dev-stack` |
| `make itest-local-selftest` | `dev/itest-local-selftest.sh`: a failed `up --wait` fails `itest-local`, runs no test and still cleans up (no containers) | `ci:dev-stack` |
| `make tools-ci` | downloads the pinned golangci-lint and squawk | — |
| `make ci` | `go-mod api-gen-check go-lint go-test govulncheck migrations-lint build go-licenses no-pulsusdb-host itest-local-selftest geo-test geo-data` | — |

The depguard rules keep `pgx`, `goose` and `internal/store/dbgen` inside `internal/store`, and
`chi` and `internal/gateway/api` inside `internal/gateway`. Two forbidigo rules (`ci:depguard`,
T06-005) keep outbound HTTP and upstream decoding in place:

- `pulsusdb-only` forbids constructing an HTTP client, transport or request (`http.Client`,
  `http.Transport`, `http.DefaultClient`, `http.Get`, `http.NewRequestWithContext`, …) outside
  `internal/pulsusdb`. Excluded: test files, the T19-002 self-check
  (`internal/gateway/selfcheck.go`) and its client in `cmd/pulsus-dash/serve.go`.
  `internal/notify`, `ai`, `auth` and `telemetry` get their exclusions with the issues that create
  them.
- `pulsusdb-decoder` forbids `json.Unmarshal`, `json.NewDecoder`, `json.RawMessage` and
  `(*json.Decoder).Decode` inside `internal/pulsusdb` (tests excepted). The invariant is that every
  decoder of PulsusDB bodies yields strings only through the redactor; today the one decoder is the
  tokenizer `updec.go`, and a later Arrow decoder joins it behind the same seam ([PulsusDB page](../server/pulsusdb.md#upstream-text-is-untrusted-t06-024)).

**Depguard self-test.** `server/scripts/check-depguard-fixture.sh` proves that the rules are
enforced (T05-002). For each fixture in `server/testdata/depguard/`, it copies `server/` into a
temporary directory, adds the fixture as `internal/<package>/zz_fixture.go` and lints that package
there. The lint must fail with the rule's message:

| Fixture | Package | Uses | Must fail with |
|---|---|---|---|
| `pgx_outside_store.go.txt` | `core` | `github.com/jackc/pgx/v5` | `pgx is used only in internal/store (T11-023, ADR-0015)` |
| `chi_outside_gateway.go.txt` | `core` | `github.com/go-chi/chi/v5` | `the router is used only in internal/gateway (T06-001)` |
| `http_client_outside_pulsusdb.go.txt` | `core` | `http.DefaultClient` | `pulsusdb-only: outbound HTTP is made only in internal/pulsusdb and the allowed packages (T06-005)` |
| `json_outside_updec.go.txt` | `pulsusdb` | `json.Unmarshal` | `pulsusdb-decoder: every upstream body decoder yields strings only through redact; encoding/json does not (§4.9)` |

If a fixture passes, it prints `depguard fixture <name> passed; rule <rule> is not enforced` and
exits 1. If the lint fails for another reason, it prints the output and `depguard fixture <name>
failed without "<desc>"`. It never writes inside the checkout and checks that `git status` is
unchanged.

### Licences (`ci:go-licenses`)

The server is AGPL-3.0 (decision D3), so every module linked into it must carry a compatible
licence ([T18-026](../../designs/technical/T18-security.md)). `server/scripts/go-licenses.sh` runs
`go-licenses check ./cmd/pulsus-dash` with this allowlist:

`MIT, BSD-2-Clause, BSD-3-Clause, Apache-2.0, ISC, MPL-2.0, LGPL-2.1, LGPL-3.0`

Anything else fails: GPL-2.0-only, source-available licences (BSL, SSPL, Elastic, Commons Clause)
and any licence go-licenses cannot recognise. The project's own module is ignored. Only modules in
the binary count: tools pinned in `go.mod` are not linked into it.

It then saves the licence files of those modules into `build/licenses/` and writes
**`build/THIRD_PARTY_NOTICES.txt`**: the lines `Pulsus Dash third-party notices` and
`Generated by make go-licenses from the Go modules linked into pulsus-dash.`, then each `LICENSE`,
`LICENCE`, `COPYING` or `NOTICE` file (any case, with an optional suffix such as `.txt`), in byte
order of its path, under a `== <module path>/<file> ==` header. It fails with `notices file is
empty` if no file was found. Last, it appends the "Data" section of `tools/geo/build.py --notices`
(`== Data ==` and one line per bundled geo dataset; [geo data](#geo-data)). CI uploads the file as the artifact `third-party-notices` (14 days);
release packaging that ships it comes later.

The self-test `server/scripts/check-go-licenses-fixture.sh` runs the gate's own check,
`go-licenses.sh --check DIR PATTERN IGNORE [EXTRA]`, on the fixture module
`server/testdata/licences/gpl`. The allowlist exists only in `go-licenses.sh`, so a change to it is
what the self-test sees: adding `GPL-2.0` to it makes `make go-licenses` fail. That module links
`example.com/gpl-dep`, whose `LICENSE` is the SPDX GPL-2.0-only text. The check must fail and name
`example.com/gpl-dep` and `GPL-2.0`. A control run that adds `GPL-2.0` on top of the allowlist
(`EXTRA`) must pass, which shows the failure comes from the licence. Both scripts work from any directory in the
repository.

When a new dependency fails the check, do not widen the allowlist: replace the dependency, or
raise it as a design question (D3).

### Generated code (`ci:api-gen`)

`api/openapi.yaml` is the HTTP contract. After editing it, or `server/queries/*.sql`, or the
migrations, run `make api-gen` and commit the result. The generated files carry no timestamp, so
regenerating is byte-stable.

`api-gen-check.sh [--root DIR] [--spec PATH]` regenerates the Go and TypeScript files into a
temporary directory and compares them with the committed ones. It runs `sqlc diff` for the sqlc
output. A difference prints `error[api-gen] <path> is stale: run make api-gen` and exits 1. It
never writes inside the checkout. The self-test copies the inputs into a temporary directory and
checks three cases there: a spec with an extra path is reported for both files; a neutral edit to
the spec passes and is kept; an edit to `schema.d.ts` fails and is kept. It then checks that the
real checkout's `git status` and generated files are unchanged.

`client/src/api/gen/` is excluded from ESLint and Prettier, and the client's `tsc` type-checks it.

### Server CI

`.github/workflows/server.yml` runs on pull requests that touch `server/`, `api/`,
`tools/api-gen/`, `client/` (the client is embedded, and the packer is `client/scripts/`),
`design/tokens.toml`, `tools/e2e/`, `Makefile`, `dev/`, `wire/` (the shared fixtures), `tools/no-pulsusdb-host/` or the
workflow, and on pushes to `main`. The token is read-only, actions are pinned by commit SHA and no
secrets are used.

| Job | Steps (gate) |
|---|---|
| `check` | `npm --prefix tools/api-gen ci` → `check-lockfile.ts tools/api-gen` (`ci:lockfile`) → `npm audit --audit-level=critical` and `npm audit signatures` for `tools/api-gen` → `make tools-ci` → `go-mod` → `api-gen-check` → `go-lint` → `go-test` → `govulncheck` → `migrations-lint` → on pull requests, the append-only check: `git diff --name-status --diff-filter=MDR origin/<base>... -- server/migrations` must print nothing, else `migrations are immutable once merged (T11-012)` (`ci:migrations`) → `npm --prefix client ci` and `make build`, then `build/pulsus-dash version` → `tools/e2e/integrity-gate.sh` (`ci:asset-integrity`) → `make go-licenses` (`ci:go-licenses`) → upload `build/THIRD_PARTY_NOTICES.txt` as artifact `third-party-notices` (14 days) |
| `dev-stack` | the same Go setup and toolchain check → `make dev-smoke` and `make itest-local-selftest` (`ci:dev-stack`) → `ci:fake-image`: `docker build -f dev/pulsus-fake.Dockerfile`, run it on port 59091, and within 10 tries 1 s apart `GET /api/v1/status/runtimeinfo` must answer with `X-Pulsus-Query-Id: fake-runtimeinfo-1` and a body with `"rollupLevels"` → `make itest-local` (every itest on PostgreSQL 15 and 16 from `dev/compose.yaml`) → always: no container of project `pulsus-dash-itest` is left, else `itest-local left containers`. Docker Compose v2 comes with the runner image |
| `itest` | PostgreSQL 16.16 and 15.20 service containers (pinned by digest, ports 55432 and 55433) → `make itest` → Node, `npm --prefix client ci`, `make build` → `smoke database` (roles and a `pulsus_smoke` database) → `tools/e2e/built-binary-smoke.sh` (F1) |

### Bench CI (`bench:cpu-instr`)

`.github/workflows/bench.yml` runs on **every** pull request (no `paths` filter: T05-006 gates
PR-level CPU regressions by instruction counts) and on pushes to `main`. Its one job installs Go
1.27.4 and the Ubuntu 24.04 `valgrind` package and runs `make cpu-instr`. Instruction counts are
stable across runners, unlike time; the time budgets run only on the reference machines
([budgets](../server/pulsusdb.md#budgets-t06-7-t05-006)).

| Workload | What one run counts |
|---|---|
| W1 | a 1 000 × 1 000 matrix decoded, placed on the grid and encoded (`POST …/promql/range`) |
| W2 | 1 000 sequential range requests for a 1-series, 60-point matrix |
| W3 | one 5 000-entry log page (50 streams of 100 entries, 120-byte lines, a tie every 10th entry) decoded, paged and encoded by `POST …/logql/range` with `limit` 4 999 |

Each count is the workload's run minus an empty run with the same file reads. The baseline
`server/testdata/bench/cpu-instr.json` holds one count per workload with the Go and valgrind
versions. A workload missing from it fails with `no baseline for W3: rebaseline`, and a new Go or
valgrind version fails with `rebaseline`. To rebaseline, run `make cpu-instr-update` in CI (a
branch whose workflow runs it, as the `bench:cpu-instr` baseline runs of #62 and #65 did) and
commit the file it writes with the change that moves it; a count more than 10 % below its
baseline prints a hint to do so.

### `ci:asset-integrity`

`tools/e2e/integrity-gate.sh` proves at binary level that a release binary whose embedded client
was altered after signing refuses to start (ADR-0016, T19-005). It runs `make build` once, then
for each case copies the packed tree into `server/internal/gateway/static/dist/`, applies one
change, rebuilds a gate binary with the same public key, and runs `serve` with nothing listening
at the Postgres URL. Verification runs first, so no database is needed. Each case must exit 1
within 10 s with the expected text on stderr:

| Case | Change | Expected |
|---|---|---|
| control | none | `assets verified`, then `postgres unreachable` |
| G1 | one byte of the largest `assets/*.js` flipped | `asset integrity check failed: hash_mismatch assets/` |
| G2 | `assets/extra.js` added | `unlisted_file assets/extra.js` |
| G3 | the first `.br` file the manifest lists deleted | `missing_file <that path>` |
| G4 | one byte of `asset-manifest.json` changed | `bad_signature` |
| G5 | built without `releasePublicKeys` | `no_public_key` |
| — | a `make server-build` binary | `no embedded client assets: …` |

The gate restores the untouched packed tree and `build/pulsus-dash` on exit.

### Built-binary smoke (F1)

`tools/e2e/built-binary-smoke.sh` needs `F1_OWNER_URL` and `F1_APP_URL` (a database with the roles
applied). It runs `build/pulsus-dash migrate` (it must print `seeded organisation "default" with
tenant binding "default"`), starts `serve` on `localhost:18080`, and checks: `msg="assets
verified" files=<n>` on stderr; `/readyz` 200 within 30 s; `GET /` (HTML) 200 with the CSP and
`Cross-Origin-Embedder-Policy: require-corp`; the first `assets/*.js` of `/asset-manifest.json`
served `Content-Encoding: br`; and exit 0 on SIGTERM.

<a id="ci-no-pulsusdb-host"></a>

## Geo data

The geomap's bundled assets ([Geomap data](../client/geomap.md)) are built by
`tools/geo/build.py`, Python standard library only, from pinned sources that are never committed or
downloaded ([supply chain](../client/supply-chain.md#geo-data)):

```text
python3 -I tools/geo/build.py SRC_DIR              write the 4 outputs (both assets, report.txt, manifest.json)
python3 -I tools/geo/build.py SRC_DIR --check      rebuild in memory: exit 0 "geo-build: 4 files identical", 1 naming each differing path
python3 -I tools/geo/build.py --fixtures [--check] client/src/vis/geo/fixtures/build/*.json from tools/geo/fixtures/basemap-cases.json
python3 -I tools/geo/build.py --notices            print the "Data" notices section
```

A build error exits 2 with `geo-build: ‹message›` on stderr. The gates: `make geo-test`
(`unit:geo-build`, `unit:geo-gazetteer-build`) and `make geo-data` (`ci:geo-data`) run in `make ci`;
the client's `unit:geo-*` tests run in `npm test`; `make geo-check GEO_SRC=<dir>` needs the sources
and runs locally. The asset rows of `ci:bundle-size` are in [bundle budgets](#bundle-budgets).

## ci:no-pulsusdb-host

The private PulsusDB host must never appear in a tracked file
([T19-010](../../designs/technical/T19-deployment.md)). The real base URL lives only in the
untracked `dev/local.env` ([dev stack page](dev-stack.md#devlocalenv)).
`tools/no-pulsusdb-host/check.py` (Python standard library only) enforces this on every pull
request. It needs no host name. CI rejects:

- any non-local host containing `pulsusdb` in a URL;
- any non-local URL used as a datasource value.

No host name is stored in the repository or in its secrets.

```bash
make no-pulsusdb-host                      # self-test, then scan every tracked file
make no-pulsusdb-host ARGS=--show-paths    # the same, naming the files (local only)
python3 -I tools/no-pulsusdb-host/check.py [--root DIR] [--show-paths]
```

By default it scans every file `git ls-files` lists; nothing is excluded. `--root DIR` scans a
directory instead (the self-test uses it). Symlinks are never followed: a link is scanned as its
target path, which is what Git stores.

### Rules

| Rule | Applies to | Finds |
|---|---|---|
| `forbidden-host` | every file: text, binary, symlinks and the checker's own fixtures | a forbidden host anywhere in the bytes, ignoring ASCII case, in any form (URL, bare name, inside a word); local runs only |
| `forbidden-host-in-path` | every file | a forbidden host in the file's path; local runs only |
| `non-local-pulsusdb-url` | text files (no NUL byte in the first 8 KiB), not symlinks, not under `tools/no-pulsusdb-host/testdata/` | a non-local host that is either (a) the host of an `http` or `https` URL containing `pulsusdb`, or (b) the value of a PulsusDB datasource key, see below |

A **datasource key** is YAML `url:` directly under a `datasource:` key; `datasource.url`;
`PULSUS_DASH_DATASOURCE_URL`; or `datasource_url` or `DatasourceURL`, each followed by `:` or `=`.
Its value is checked only when it is an `http` or `https` URL.

**Forbidden hosts** apply only to local runs. They are the entries of the optional
`DASH_FORBIDDEN_HOSTS` variable, comma- or newline-separated, trimmed, lower-cased, numbered from
1 (an entry written as a URL is reduced to its host), then the host of `PULSUS_DASH_DATASOURCE_URL`
if it is set and not local, as the last entry. `make no-pulsusdb-host` loads `dev/local.env` first,
so a local run also forbids your real host in any form, even without `pulsusdb` in it. CI sets
neither variable, and if neither is set the scan runs the URL rule alone, without a warning.

**Local hosts**, which the URL rule accepts, are: `localhost` and names ending in `.localhost`;
loopback addresses (`127.0.0.0/8` and `::1` in any spelling, with or without a zone); names ending in
`.example`, `.test` or `.invalid`; `example.com`, `example.net`, `example.org` and their subdomains;
and the compose service name `pulsus-fake`. A single-label name such as `pulsusdb` is not local.
Documentation and examples should use `pulsusdb.example` or `localhost`.

The URL rule reads the host from the authority: userinfo, port, brackets around IPv6, an IPv6 zone
(`%25eth0` or `%eth0`) and a trailing dot are removed, and case is ignored. It never matches SQL by
table name: a binding URL in SQL is caught only by the `pulsusdb` rule or the forbidden-host list.
In YAML, blank and comment lines between `datasource:` and `url:` are skipped.

### Output and identifiers

The checker never prints a path, a host, the text of a line, an argument or a git message. A file is
`F<i>`, its 1-based position in the sorted list of scanned files (`git ls-files` in byte order). For
example:

```text
error[forbidden-host] F12:3 (entry 1)
error[forbidden-host-in-path] F40 (entry 2)
error[non-local-pulsusdb-url] F7:2
no-pulsusdb-host: 3 finding(s) in 506 files; run make no-pulsusdb-host ARGS=--show-paths locally to see paths
```

`:3` is the line, and `entry 1` is the first forbidden host. To find the file, run
`make no-pulsusdb-host ARGS=--show-paths` locally: it prints the relative path instead of `F<i>`,
with control characters escaped as `\xNN` and `::` written as `: :`. `--show-paths` is refused
when `CI` is set. A clean run ends with `no-pulsusdb-host: clean (<m> files)`.

### Exit codes and errors

| Exit | When | Message (stderr) |
|---|---|---|
| 0 | no finding | — |
| 1 | findings (on stdout), and none of the errors below | — |
| 2 | invalid arguments | `error[usage] invalid arguments` |
| 2 | `--show-paths` with `CI` set | `error[usage] --show-paths is refused in CI` |
| 2 | `git ls-files` failed | `error[git] ls-files failed` |
| 2 | `--root` is not a directory | `error[bad-root] --root is not a directory` |
| 2 | a file or link could not be read (the scan continues) | `error[unreadable] F<i> (<errno name>)` |
| 2 | a directory under `--root` could not be listed (the scan continues) | `error[unreadable] a directory under --root could not be listed` |
| 2 | any other error | `error[internal] <exception class>` |

An unknown option, including the removed `--require-secret`, is a usage error.

### Limits

Bare host names without a scheme are not scanned. CI knows no host name, so it misses a private
host that has no `pulsusdb` in its name unless it is a datasource URL; only a local run with
`dev/local.env` forbids it in any form.
The rule for contributors is simple: never commit a real host name. Keep the real base URL in
`dev/local.env` and nowhere else.

### Self-test

The checker's tests use only fictional hosts (`.corp` names and reserved names). Its fixtures are in
`tools/no-pulsusdb-host/testdata/`, where only the URL rule is switched off in repository mode.

### CI (`hygiene.yml`)

`.github/workflows/hygiene.yml` runs on every pull request and on pushes to `main`, with a read-only
token. Its one job, `no-pulsusdb-host`, runs the checker's self-test
(`python3 -I -m unittest discover -s tools/no-pulsusdb-host -p 'test_*.py'`), then
`check.py` ([above](#ci-no-pulsusdb-host)). It reads no secret, so pull requests from forks run it
too.
