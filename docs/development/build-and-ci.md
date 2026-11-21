# Build, test and CI

How to build and check the web client and the server locally, and what CI runs. The client is
TypeScript, React and Vite in `client/` ([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md)).
The server is Go in `server/` ([ADR-0015](../../designs/adr/0015-go-bff.md)); see
[Server](#server). The gate IDs are those of the
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
| `npm run dev` | Vite dev server on `localhost:5173` (COOP and COEP only, no CSP; stub API by default) | — |
| `npm run build` | `tsc -p tsconfig.app.json --noEmit`, then `vite build` into `client/dist/` (hashed names, `assetsInlineLimit: 0`, Vite manifest in `dist/.vite/manifest.json`) | build |
| `npm run preview` | Serves `dist/` on `localhost:4173` with the production headers (`config/headers.ts`) | — |
| `npm run lint` | ESLint (`--max-warnings=0`) and `prettier --check .` | `ci:lint-ts` |
| `npm run typecheck` | `tsc` over `tsconfig.app.json` (browser code), `tsconfig.node.json` (scripts, ESLint plugin, configs; Node ESM resolution) and `e2e/tsconfig.json` (end-to-end tests, bundler resolution, because they import `src/` modules such as the gallery generator and the brush snap unit) | `ci:typecheck` |
| `npm test` | Vitest: project `node` (scripts and config) and project `dom` (jsdom, Testing Library) | `unit:*` |
| `npm run e2e` | Playwright against the BFF-served builds ([end-to-end tests](#end-to-end-tests)) | `e2e:*`, `golden:interim-gallery`, `bench:startup`, `bench:frame-interim-line`, `bench:frame-interim-heatmap`, `bench:inp-rooms` |
| `npm run tokens` | Regenerates `src/styles/tokens.css` and `tokens.ts` from `../design/tokens.toml`; `-- --check` compares instead of writing | `ci:token-lint` (regenerate) |
| `npm run token-lint` | Colour, size, duration and state-token literals outside the tokens | `ci:token-lint` |
| `npm run size` | Brotli sizes of `dist/` against `bundle-budgets.json` | `ci:bundle-size` |
| `npm run check:lockfile` | Exact versions, lockfile v3, registry and integrity of every locked package | `ci:lockfile` |
| `npm run origins` | No URL of another origin in a resource position of the build, no unlisted URL text | `ci:dep-audit` (build origins) |
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
| `bundle-size.ts [dist] [budgets]` | within budget | over budget or an artefact missing | `dist/` or manifest unreadable | `over-budget:<class>`, `missing-artefact:<what>` | built in a temporary directory by `bundle-size.test.ts` |
| `token-lint.ts [root]` | no findings | findings | a file does not parse | `colour-literal`, `size-literal`, `duration-literal`, `state-token`, `computed-token-name`, `suppressed-token-rule` | `scripts/__fixtures__/token-lint/bad` (and `good`, which must pass) |
| `gen-tokens.ts [--check]` | written / up to date | a generated file is stale (`stale-generated:<file>`) | invalid tokens (the message names the key) | — | `gen-tokens.test.ts` (`canvas = "blue"`) |
| `check-build-origins.ts [dist] [policy]` | no errors (warnings allowed) | findings | a file does not parse | `third-party-resource`, `third-party-host`, `computed-url`; warning `unused-url-allowlist` | `scripts/__fixtures__/origins/bad` (and `good`) |
| `pack-assets.ts --gen-key DIR` / `--in DIST --out OUT --key KEY` | packed / key pair written | — | `pack: <reason>` | — | `pack-assets.test.ts` (a symlink, a missing `--in`) |

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
- **End-to-end tests** (`client/e2e/*.spec.ts`) run in Chromium, Firefox and WebKit against the
  BFF, which serves the client with the production headers; see
  [end-to-end tests](#end-to-end-tests). `Date.now()` is frozen with `page.clock.setFixedTime(T)`.
  To run one engine locally: `npm run e2e -- --project=chromium`.
- **Keyboard coverage** (`e2e/keyboard.spec.ts`, part of `e2e:a11y-rooms`): see
  [the client page](../client/README.md#keyboard-coverage).
- **`bench:inp-rooms`** (`e2e/perf-inp-rooms.spec.ts`, Chromium only, PRF-033, T05 §4.3): scripted
  pointer and keyboard interactions on the board room (Appendix C-A §A.6 of plan #61 Part C), in
  three documents: `/t/demo/board/b-1` (the section toggle five times both ways, the star three
  times both ways), `/t/demo/board/b-3` (a variable chip, typing and Apply; `+ Filter`, Add and
  Remove filter; three times each), and `/t/demo/board/b-1` again (Edit board, Add section, Done
  and Discard changes, three times). An init script observes the Event Timing entries (`event`,
  `durationThreshold` 16) in every document the page loads and flushes them before each
  navigation; `scripts/inp.ts` (`aggregateInp`, `gateFailures`) computes **INP per document**
  (each interaction once, at its longest entry; the durations padded with zeros to the
  document's scripted count, then the `floor(n / 50)`-th largest, so one outlier per 50
  interactions of that document is ignored), never pooled across documents. The test always
  checks three documents, each with its scripted count, and no page error. The 200 ms limit
  applies per document; 100 ms is the target. On CI's shared runners the check is **report only**
  until the reference lab exists (#68, T05-006): a document above 200 ms adds a `warning`
  annotation. With `INP_GATE=enforce` (the reference lab, and local gate proofs) any document above
  200 ms fails the test, naming the document, its INP and its slowest step. Both modes write
  `test-results/bench-inp-rooms.json` (`documents[]` with `doc`, `url`, `inp`, `n`, `reported`,
  `slowest`; `worst`, `mode`, `limitMs`, `targetMs`, `unit`) and a `bench:inp-rooms` annotation with
  the same JSON. To run it alone: `npx playwright test perf-inp-rooms --project=chromium`
  (`INP_GATE=enforce npx playwright test perf-inp-rooms --project=chromium` for the blocking form).
- **`bench:startup`** (`e2e/perf-cold-load.spec.ts`, Chromium only, report only, PRF-008): 20 cold
  loads of `/t/demo/boards`, time to the `shell-ready` performance mark; p50 and p75 are written to
  `test-results/prf-008.json` and added as a test annotation. There is no threshold.
- **Chart tests** (#58; see [Charts](../client/charts.md)). The engine's unit tests draw into
  `src/test/recordingContext.ts`, a 2D context that records every call (text measured at 7 px per
  character), and run the animation frames themselves (`src/test/engineHarness.ts`); component tests
  use `src/test/fakeEngine.ts` and `src/test/fakeResizeObserver.ts`. The end-to-end chart specs use
  the chart gallery at 12:00–13:00 UTC on 19 Nov 2026 (`GALLERY_URL` in `e2e/helpers.ts`):
  - **`golden:interim-gallery`** (`e2e/golden-gallery.spec.ts`, Chromium only): each of the seven
    gallery frames in dark and light, compared with `toHaveScreenshot` against
    `e2e/__screenshots__/golden-gallery.spec.ts/gallery-<id>-<theme>.png` (per-pixel threshold 0.1,
    at most 0.2 % of pixels different, animations off, caret hidden, CSS scale), after the fonts are
    loaded and two animation frames; a reload must give the same pixels. Baselines are never written
    locally or on a normal run (`updateSnapshots: 'none'`): they come only from CI's Chromium on
    `ubuntu-24.04`. To change them, add the `golden-update` label to the pull request; the e2e jobs
    rerun with `PW_UPDATE_GOLDENS=1`, the Chromium job writes new baselines and uploads them as the
    `e2e-screenshots` artefact; download it, review the images and commit them to
    `client/e2e/__screenshots__/`, then remove the label.
  - **`e2e:chart-brush`** (`e2e/chart-brush.spec.ts`): a drag on `line-1` from 0.1–0.4 brush units
    inside 12:20 to the same inside 12:25 must give exactly `from=…12:20:00.000Z`,
    `to=…12:25:00.000Z`; a double-click then gives 12:17:30–12:27:30 and the header shows it.
  - **`e2e:chart-hover`** (`e2e/chart-hover.spec.ts`): the `line-gaps` tooltip lists the time and the
    three series with the values the generator gives; on `line-50` a pointer sweep down the plot
    shows every one of the 50 series; on `bars` all five levels at every height.
  - **`bench:frame-interim-line`** (`e2e/perf-chart-redraw.spec.ts`, Chromium only, report only
    until #68): 40 theme changes, the `chart-draw` measure of the 50 × 1 440 line chart each time;
    p50 and p95 are written to `test-results/bench-interim-line.json` and added as an annotation.
    There is no threshold. The page is opened without Playwright's fake clock, which replaces the
    User Timing methods.
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

### End-to-end tests

`npm run e2e` (or `make e2e`) starts four servers (`client/playwright.config.ts`):

| Server | Command | Used by |
|---|---|---|
| PulsusDB fake on `localhost:4190` (first; ready on `/__fake/requests`) | `tools/e2e/fake.sh 4190` | both BFFs' data source; the specs read its request records through `e2e/fake.ts` ([control mode](testing-pulsusdb.md#in-the-e2e-suite-control-mode)) |
| stub-mode BFF on `localhost:4173` | `tools/e2e/serve.sh stub 4173` | every existing spec (`baseURL`): the stub's seeded boards and tenants, served with the real headers; and `e2e:bff-headers` |
| http-mode BFF on `localhost:4174` | `tools/e2e/serve.sh http 4174` | `e2e:bff-http-shell` (`bff-http.spec.ts`): the shell bootstraps from `GET /api/dash/v1/bootstrap`; `e2e:board-edit-save`, `e2e:board-tall` and `e2e:board-sections` (`board-edit.spec.ts`): boards created, laid out, saved and reloaded through the boards API, and collapsed sections, their URL overrides and saved state; `e2e:board-prefs` (`board-prefs.spec.ts`): Starred and Recent across two tabs and a fresh browser context (each test creates its own uniquely named board and deletes it in `finally`) |
| Vite dev on `localhost:5174` | `npx --no-install vite --port 5174 --strictPort` with `VITE_API_MODE=http` and `PULSUS_DASH_DEV_BFF=http://localhost:4174` | `dev-proxy.spec.ts`: the developer path shows the server version |

Before a run:

1. `make e2e-build` builds the two BFF binaries, `build/e2e-stub/pulsus-dash` and
   `build/e2e-http/pulsus-dash` (version `0.1.0-e2e`), each with its client embedded, and the
   fake, `build/e2e-fake/pulsus-fake`.
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

`E2E_SERVER=preview npm run e2e` restores the old single server (`npm run build && npm run
preview`, no database); the `bff-*` and `dev-proxy` specs then skip themselves. `bff-headers`,
`bff-http` and `dev-proxy` run on Chromium only.

- **`e2e:bff-headers`** (`bff-headers.spec.ts`): `GET /` has `Content-Security-Policy` equal to
  `CSP` from `config/headers.ts` and every other document header; the first `/assets/*.js` the page
  loads, requested with `Accept-Encoding: br`, is served `br` and `immutable`; `/t/demo/boards`
  returns `index.html`; `/api/nope` is the 404 envelope.
- **`e2e:bff-http-shell`** (`bff-http.spec.ts`, `dev-proxy.spec.ts`): on the http build, `/` opens
  `/t/demo/boards`; About shows `Server version 0.1.0-e2e`; there is no Sign out item; the sidebar
  shows `Data source: demo · Connected`, and the fake lists at least one completed
  `/api/v1/status/runtimeinfo` request answered by the `runtimeinfo` transcript (T06-025); no
  console errors. Through the dev server, About shows
  the same version.

## CI

`.github/workflows/client.yml` runs on pull requests that touch `client/`, `design/tokens.toml`,
`server/`, `api/`, `tools/e2e/`, `wire/` (the shared fixtures), `dev/pulsus-fake.*`, `Makefile` or
the workflow (opened, synchronised, reopened, and
labelled, so adding `golden-update` reruns it), and on pushes to `main`. Actions are pinned by commit SHA, the token is read-only and
no secrets are used.

| Job | Steps (gate) |
|---|---|
| `check` | `npm ci` (`ci:lockfile` install) → `check:lockfile` (`ci:lockfile`) → `lint` (`ci:lint-ts`) → `typecheck` (`ci:typecheck`) → `tokens -- --check` and `token-lint` (`ci:token-lint`) → `test` (unit) → `build` (with `VITE_GIT_SHA`) → `size` (`ci:bundle-size`) → an `http` build into `dist-http/` whose manifest must not contain `src/dev/` (the chart gallery is absent from `http` builds) → `origins` (`ci:dep-audit`, build origins) → `audit` (`ci:dep-audit`, `ci:npm-audit`) |
| `e2e` | after `check`, one job per engine (`chromium`, `firefox`, `webkit`), with a PostgreSQL 16.16 service on port 55432: `npm ci`, Go 1.27.4 and its toolchain check, install that browser with its system dependencies, `e2e database` (applies `server/deploy/postgres-roles.sql` and creates `pulsus_e2e`), `make e2e-build`, `npm run e2e -- --project=<engine>` with `E2E_PG_APP_URL` and `E2E_PG_OWNER_URL` (`PW_UPDATE_GOLDENS=1` only on Chromium with the `golden-update` label); the HTML report and `test-results/` are uploaded for 14 days, and the Chromium job also uploads `e2e/__screenshots__/` as `e2e-screenshots`. Golden and bench specs run on Chromium only. CI retries a failed test once |

The end-to-end jobs need the browsers' system libraries, which `--with-deps` installs on the CI
image. On a workstation without them, install the packages Playwright names, or run only the
engines whose libraries are present.

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
| `make e2e-build` | `make build` twice, `API_MODE=stub` into `build/e2e-stub/pulsus-dash` and `API_MODE=http` into `build/e2e-http/pulsus-dash`, both `VERSION=0.1.0-e2e`; and the PulsusDB fake, `CGO_ENABLED=0 go build -trimpath` of `./cmd/pulsus-fake` into `build/e2e-fake/pulsus-fake` | — |
| `make e2e` | `npm --prefix client run e2e` | `e2e:*` |
| `make server-build` | builds `build/pulsus-dash` without the client (`VERSION ?= 0.1.0-dev`); its `serve` refuses to start unless `--api-only` | — |
| `make api-gen` | regenerates `server/internal/gateway/api/api.gen.go` (oapi-codegen), `server/internal/store/dbgen` (sqlc) and `client/src/api/gen/schema.d.ts` (openapi-typescript) | — |
| `make api-gen-check` | `server/scripts/api-gen-check.sh`, then its self-test `server/scripts/test-api-gen-check.sh` | `ci:api-gen` |
| `make go-mod` | `go mod verify` and `go mod tidy -diff` | `ci:go-mod` |
| `make go-lint` | golangci-lint 2.15.0 with `server/.golangci.yml` (depguard, errcheck, forbidigo, gosec, govet, ineffassign, staticcheck, unused; also over `itest` files), then the depguard self-test `server/scripts/check-depguard-fixture.sh` | `ci:go-lint`, `ci:depguard` |
| `make go-test` | `go test -race ./...` | `ci:go-test` |
| `make govulncheck` | `govulncheck ./...` | `ci:govulncheck` |
| `make migrations-lint` | squawk over `server/migrations/*.sql`, then the failing fixture must fail with `require-concurrent-index-creation` | `ci:migrations` |
| `make itest` | `go test -race -tags itest` against the clusters in `DASH_ITEST_PG_URLS` ([database page](../server/database.md#integration-tests)), with the PulsusDB fake in-process ([testing against PulsusDB](testing-pulsusdb.md)) | `itest:rls-isolation`, `itest:no-extensions`, `itest:migrations`, `itest:promql-range`, `itest:promql-errors`, `itest:cancel`, `itest:cancel-mid-stream`, `itest:tenant-header`, `itest:datasource-check`; `itest:pulsusdb-contract` runs only with `DASH_CONTRACT_PULSUSDB_URL` and is skipped in CI |
| `make cpu-instr` | `server/scripts/cpu-instr.sh`: writes the workload bodies first (outside valgrind, so the input is not counted), then runs the BFF workloads W1 and W2 under cachegrind, minus an empty run that reads the same input, against `server/testdata/bench/cpu-instr.json`; more than +3 % fails, and so does a Go or valgrind version other than the baseline's (`rebaseline`). Needs valgrind | `bench:cpu-instr` |
| `make cpu-instr-update` | rewrites the baseline; run it in CI and commit the result with the change that moves it | — |
| `make bench-bff` | the two time budgets `TestBudgetPromqlDecode` and `TestBudgetBffOverhead`: with `REFERENCE_LAB=1` they fail over 30 ms per 10⁶ points, or over 5 ms (p50) and 20 ms (p99) of BFF overhead; without it they skip ([budgets](../server/pulsusdb.md#budgets-t06-7-t05-006)) | `bench:promql-decode`, `bench:bff-overhead` (reference lab) |
| `make go-licenses` | `server/scripts/go-licenses.sh` (licence check and `build/THIRD_PARTY_NOTICES.txt`), then its self-test `server/scripts/check-go-licenses-fixture.sh` | `ci:go-licenses` |
| `make no-pulsusdb-host` | the checker's self-test, then (only if it passes) the scan of every tracked file; reads `dev/local.env` if present. `ARGS=--show-paths` names the files | `ci:no-pulsusdb-host` |
| `make itest-local`, `make dev-up`, `dev-db`, `dev-migrate`, `dev-down`, `dev-reset` | the dev compose stack ([dev stack page](dev-stack.md)) | — |
| `make dev-smoke` | `dev/smoke.sh`, then `dev/smoke-selftest.sh` ([dev stack page](dev-stack.md#smoke-test-cidev-stack)) | `ci:dev-stack` |
| `make itest-local-selftest` | `dev/itest-local-selftest.sh`: a failed `up --wait` fails `itest-local`, runs no test and still cleans up (no containers) | `ci:dev-stack` |
| `make tools-ci` | downloads the pinned golangci-lint and squawk | — |
| `make ci` | `go-mod api-gen-check go-lint go-test govulncheck migrations-lint build go-licenses no-pulsusdb-host itest-local-selftest` | — |

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
  `(*json.Decoder).Decode` inside `internal/pulsusdb` (tests excepted), so its tokenizer `updec.go`
  is the only decoder of PulsusDB bodies ([PulsusDB page](../server/pulsusdb.md#upstream-text-is-untrusted-t06-024)).

**Depguard self-test.** `server/scripts/check-depguard-fixture.sh` proves that the rules are
enforced (T05-002). For each fixture in `server/testdata/depguard/`, it copies `server/` into a
temporary directory, adds the fixture as `internal/<package>/zz_fixture.go` and lints that package
there. The lint must fail with the rule's message:

| Fixture | Package | Uses | Must fail with |
|---|---|---|---|
| `pgx_outside_store.go.txt` | `core` | `github.com/jackc/pgx/v5` | `pgx is used only in internal/store (T11-023, ADR-0015)` |
| `chi_outside_gateway.go.txt` | `core` | `github.com/go-chi/chi/v5` | `the router is used only in internal/gateway (T06-001)` |
| `http_client_outside_pulsusdb.go.txt` | `core` | `http.DefaultClient` | `pulsusdb-only: outbound HTTP is made only in internal/pulsusdb and the allowed packages (T06-005)` |
| `json_outside_updec.go.txt` | `pulsusdb` | `json.Unmarshal` | `pulsusdb-decoder: upstream bodies are decoded only by updec.go, which redacts every string (§4.9)` |

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
empty` if no file was found. CI uploads the file as the artifact `third-party-notices` (14 days);
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
`design/tokens.toml`, `tools/e2e/`, `Makefile`, `dev/`, `wire/` (the shared fixtures),
`tools/no-pulsusdb-host/` or the workflow, and on pushes to `main`. The token is read-only, actions
are pinned by commit SHA and no secrets are used.

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

## ci:no-pulsusdb-host

The private PulsusDB host must never appear in a tracked file
([T19-010](../../designs/technical/T19-deployment.md)). The real base URL lives only in the
untracked `dev/local.env` ([dev stack page](dev-stack.md#devlocalenv)).
`tools/no-pulsusdb-host/check.py` (Python standard library only) enforces this on every pull
request.

```bash
make no-pulsusdb-host                      # self-test, then scan every tracked file
make no-pulsusdb-host ARGS=--show-paths    # the same, naming the files (local only)
python3 -I tools/no-pulsusdb-host/check.py [--root DIR] [--require-secret] [--show-paths]
```

By default it scans every file `git ls-files` lists; nothing is excluded. `--root DIR` scans a
directory instead (the self-test uses it). Symlinks are never followed: a link is scanned as its
target path, which is what Git stores.

### Rules

| Rule | Applies to | Finds |
|---|---|---|
| `forbidden-host` | every file: text, binary, symlinks and the checker's own fixtures | a forbidden host anywhere in the bytes, ignoring ASCII case, in any form (URL, bare name, inside a word) |
| `forbidden-host-in-path` | every file | a forbidden host in the file's path |
| `non-local-pulsusdb-url` | text files (no NUL byte in the first 8 KiB), not symlinks, not under `tools/no-pulsusdb-host/testdata/` | an `http` or `https` URL whose host is not local and either contains `pulsusdb`, or is the value of a PulsusDB datasource key: YAML `url:` directly under a `datasource:` key; `datasource.url`; `PULSUS_DASH_DATASOURCE_URL`; `datasource_url` or `DatasourceURL`, followed by `:` or `=` |

**Forbidden hosts** are the entries of `DASH_FORBIDDEN_HOSTS`: comma- or newline-separated,
trimmed, lower-cased, numbered from 1. An entry written as a URL is reduced to its host. If
`PULSUS_DASH_DATASOURCE_URL` is set and its host is not local, that host is added as the last
entry. `make no-pulsusdb-host` loads `dev/local.env` first, so a local run also forbids your real
host.

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
| 2 | no `DASH_FORBIDDEN_HOSTS` entry and `--require-secret` | `error[missing-secret] DASH_FORBIDDEN_HOSTS is not set: …` |
| 2 | any other error | `error[internal] <exception class>` |

Without `--require-secret`, a missing secret prints `warning[missing-secret] …` and the scan
continues with the URL rule and the datasource host only.

### The `DASH_FORBIDDEN_HOSTS` secret

CI reads the forbidden hosts from the repository secret `DASH_FORBIDDEN_HOSTS`. A repository owner
creates it once, in the repository's Actions secrets, holding the private PulsusDB host or hosts,
comma-separated. Until it exists, the `hygiene` workflow fails on every pull request with the
missing-secret message: the gate never passes silently. Pull requests from forks cannot read
repository secrets, so their run fails the same way; a maintainer runs the check from a branch in
the repository instead.

The checker's tests use only fictional hosts (`.corp` names and reserved names). Its fixtures are in
`tools/no-pulsusdb-host/testdata/`, where only the URL rule is switched off in repository mode.

### CI (`hygiene.yml`)

`.github/workflows/hygiene.yml` runs on every pull request and on pushes to `main`, with a read-only
token. Its one job, `no-pulsusdb-host`, runs the checker's self-test
(`python3 -I -m unittest discover -s tools/no-pulsusdb-host -p 'test_*.py'`), then
`check.py --require-secret` with the `DASH_FORBIDDEN_HOSTS` secret
([above](#ci-no-pulsusdb-host)). It is the only workflow that reads a secret.
