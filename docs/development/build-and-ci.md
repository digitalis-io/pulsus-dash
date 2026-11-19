# Build, test and CI

How the Cargo workspace is laid out, how to build it for native and the browser, and how every CI
gate works, locally and in GitHub Actions.

Implements [T01-001 and T01-002](../../designs/technical/T01-frontend-architecture.md),
[T03-001, T03-005, T03-008 and T03-024](../../designs/technical/T03-browser-runtime.md) (the CI
lints, the generated layout and the probe check) and
[T05-001 and T05-002](../../designs/technical/T05-testing-and-performance.md), following
[ADR-0001](../../designs/adr/0001-rust-wasm-everywhere.md) and
[ADR-0002](../../designs/adr/0002-no-js-ui-framework.md). The gate catalogue is
[T05 §7.1](../../designs/technical/T05-testing-and-performance.md#71-gate-catalogue).

## Prerequisites

- `rustup`. The toolchain is pinned in `rust-toolchain.toml` (stable 1.98.0 with `rustfmt`,
  `clippy` and the `wasm32-unknown-unknown` target); `rustup toolchain install` in the repository
  root installs it, and every `cargo` command picks it up.
- `git`: `ci:shim-lint` and `ci:dep-audit` ask git which files under `web/shim/` exist.
- `python3`: `ci:design-check` runs `designs/tools/check.py`.
- `curl` and `tar`: `cargo xtask tools` downloads binaryen's `wasm-opt`.
- For the `golden` gate: Vulkan with Mesa's lavapipe (`libvulkan1`, `mesa-vulkan-drivers`). CI
  installs the version pinned in `ci/tools.toml` (`mesa`); `lavapipe_pinned` checks that the
  adapter's driver is that Mesa (`mesa_upstream`), so a local run with another Mesa fails that one
  test only.
- Node.js 22 (`npm`, `npx`): only for the `e2e` gate (Playwright, test tooling; nothing from npm is
  shipped). Run `npm ci` and `npx playwright install --with-deps chromium` in `e2e/` once.

Network access is needed for crates.io, the pinned nightly and binaryen (`cargo xtask tools`) and
npm (`e2e/` only).

## Commands

| What | Command |
|---|---|
| Native build of every crate | `cargo build --workspace --locked` |
| Browser build (stable, no bindgen) | `cargo build-wasm` → `target/wasm32-unknown-unknown/wasm-release/dash_core_mt.wasm` |
| Install the pinned build tools | `cargo xtask tools` |
| Both core artefacts into `web/shim/gen/` | `cargo xtask gen` (also rewrites `web/shim/layout.gen.js` when stale) |
| Probe-enabled test build into `target/web-test/` | `cargo xtask gen --test` |
| Dev server with the runtime's headers | `cargo xtask serve [--root DIR] [--port N] [--no-isolation]` |
| One gate | `cargo xtask ci <gate-id>` |
| All gates, in CI order | `cargo xtask ci all` |
| Write a gate's deliberate regression | `cargo xtask seed <gate-id>` |
| Undo it | `cargo xtask unseed <gate-id>` |

`cargo build-wasm` and `cargo xtask` are aliases in `.cargo/config.toml`. `build-wasm` builds
`dash-core-mt` with the `wasm-release` profile (fat LTO, one codegen unit, `panic = "abort"`;
T03 §5.6). Every command uses `--locked`: `Cargo.lock` is committed, and a change that needs a new
lock entry must commit it.

Exit codes of `cargo xtask`:

| Invocation | 0 | 1 | 2 |
|---|---|---|---|
| `ci <gate-id>` | passed (bundle-size report mode: also with warnings) | failed: violations, or the tool exited non-zero | error (bad config, tool missing, I/O) or unknown gate |
| `ci all` | all passed | any gate failed | any error (takes precedence) |
| `seed <gate-id>` | seed and manifest written; paths printed | — | error or unknown gate |
| `unseed <gate-id>` | seed undone, manifest deleted; paths printed | — | no manifest, a seeded file changed since seeding, or unknown gate |
| `tools`, `gen [--test]` | done | — | error (a tool exited non-zero, a checksum mismatch, a memory check failed) |
| `serve …` | runs until stopped | — | cannot bind, bad arguments |

Every finding prints as `error[<rule-id>] <path>[:<line>]: <message>`. Under GitHub Actions it is
also emitted as an `::error` annotation, so it shows on the PR diff.

## Layout

| Path | Contents |
|---|---|
| `Cargo.toml` | The one root workspace (`crates/*`, `xtask`), shared package keys and lints |
| `crates/` | Browser, shared (⇄) and test crates: `dash-core-mt` (the core WASM module), `dash-gpu`, `dash-scene`, `dash-marks`, `dash-scales`, `dash-axes`, `dash-tokens`, `dash-wire`; test crates `pulsus-synth` (also the runtime's synthetic data source), `dash-golden`, `dash-lab`. Crates not implemented yet are stubs that name their design and implementing issue |
| `server/` | BFF-only crates (M-UI1, T06 §4.1); not created yet |
| `xtask/` | The gate runner and seeds (this page) |
| `ci/` | Gate registry and gate configuration |
| `web/index.html` | The runtime demo page ([Browser runtime](../runtime/browser-runtime.md)) |
| `web/shim/` | The JS shim: only the T03 §5.1 files (today `boot.js`, `worker.js`, `input.js`) and the generated `layout.gen.js` |
| `web/shim/gen/` | Git-ignored wasm-bindgen output of `dash-core-mt` and `dash-core-st`, accepted only by regenerate-and-compare (`ci:dep-audit`) |
| `e2e/` | Playwright specs of the runtime mode matrix (test tooling only) |
| `ci/tools.toml` | The pinned nightly, wasm-bindgen, binaryen (with checksums) and Mesa versions |

The crate map is [T01 §4.6](../../designs/technical/T01-frontend-architecture.md#46-crate-map).

**Adding a crate.** Create `crates/<name>/` with `version`, `edition`, `rust-version`,
`license-file` and `publish` set to `.workspace = true` and `[lints] workspace = true`. A crate the
browser needs is added to `[workspace.dependencies]` and as a dependency of `dash-core-mt`, so
`cargo build-wasm` compiles it for wasm32. Test crates are never dependencies of `dash-core-mt`.
Commit the updated `Cargo.lock`.

Workspace lints deny `unwrap`, `expect`, `dbg!`, `todo!` and `unimplemented!` outside tests
(`clippy.toml` allows them in tests).

## Gates

The registry is `ci/gates.toml`: one entry per gate with its T05 id, owner and CI job
(T05-001). `.github/workflows/ci.yml` runs five jobs on every pull request and on pushes to `main`.
Each gate is one step named `ci <gate-id>` that runs `cargo xtask ci <gate-id>`, exactly what you
run locally.

| Gate id | T05 gate | Owner | Job | Checks |
|---|---|---|---|---|
| `fmt` | — | `area:platform` | `rust` | `cargo fmt --all --check` |
| `build` | — | `area:platform` | `rust` | `cargo build --workspace --locked` |
| `clippy` | — | `area:platform` | `rust` | `cargo clippy --workspace --all-targets --locked -- -D warnings`, then the same for `dash-core-mt` on `wasm32-unknown-unknown` |
| `test` | — | `area:platform` | `rust` | `cargo test --workspace --locked` |
| `golden` | `golden:decimation-ref` | `area:rendering` | `golden` | `cargo test --locked --release -p dash-golden -- --ignored --test-threads=1` on lavapipe (below) |
| `wasm` | — | `area:platform` | `wasm` | `cargo build-wasm`, then `cargo xtask gen`'s release build of both artefacts into `web/shim/gen/` |
| `probe-absent` | `ci:probe-absent` | `area:platform` | `wasm` | no test probe in a fresh release build (T03-024) |
| `bundle-size` | `ci:bundle-size` | `area:rendering` | `wasm` | Brotli size per artefact against T03 §7.3 |
| `dep-audit` | `ci:dep-audit` | `area:platform` | `wasm` | npm, browser crate graph, `web-sys` features, render-worker locks, web assets, shipped JS |
| `design-check` | `ci:design-check` | `area:platform` | `static` | `designs/tools/check.py` and the traceability diff |
| `shim-lint` | `ci:shim-lint` | `area:shell` | `static` | T03-001 on the shim |
| `e2e` | `e2e:mode-matrix` | `area:rendering` | `e2e` | Playwright mode matrix, the PRF-005 trace check, the T03-003 shim queue checks (times reported only) and the `bench:frame-line-1e8` report |

The `wasm` and `e2e` jobs run `cargo xtask tools` first; the `golden` job installs lavapipe. The `static` job also runs `python3 -I designs/tools/check.py` on the checkout as its last step,
even when an earlier gate failed.

Which checks are *required* to merge is a repository setting made by the owner; this repository
only defines the checks.

### `golden`

The `golden` job installs `libvulkan1` and `mesa-vulkan-drivers` at the `mesa` version of
`ci/tools.toml` (the `apt-cache policy mesa-vulkan-drivers` Candidate on `ubuntu-24.04`), then runs
the ignored tests of `crates/dash-golden/tests/decimation_ref.rs` in a release build, one at a time
(`golden:decimation-ref`, T05 §4.2). They render the line chart on lavapipe with the limits of each
browser tier and compare GPU records with the CPU specification, the mask pass with the exact line
coverage (zero missing and zero extra pixels) and the decimated image with the reference that draws
every raw segment; see [Line chart](../rendering/line-chart.md#tests-and-gates). The heaviest test
(`draw_parity`, 10⁸ reference segments per view) runs its views on up to four lavapipe devices in
parallel. To update the Mesa pin when the runner's Candidate changes, set `mesa` to the new apt
version and `mesa_upstream` to its `x.y.z` (`tools_config_matches_lock` checks the shape).

### Fixing a cargo gate

Run the same command locally. `fmt`: run `cargo fmt` on the files you changed. `clippy`: fix the
lint; do not add `allow` attributes without a reason in the code. `wasm`: the crate uses something
that does not exist on `wasm32-unknown-unknown` (for example `std::os::unix`), or a dependency that
does not build for it.

### `ci:shim-lint`

Counts the non-blank, non-comment lines of every `.js`, `.mjs` and `.cjs` file under `web/shim/`
that git tracks or does not ignore (`git ls-files --cached --others --exclude-standard`). The one
exclusion is `web/shim/layout.gen.js` while it is byte-identical to
`dash_protocol::layout::render_js()`; otherwise it is counted and fails `layout-gen-stale`. A file
force-added under `gen/` is counted. It then checks:

| Rule id | Fails when |
|---|---|
| `shim-dir-missing` | `web/shim/` does not exist |
| `shim-line-budget` | the total is over 300 (T03-001) |
| `shim-forbidden-token` | `eval`, `Function` or `innerHTML` appears as a word in code or strings |
| `shim-import` | an import, re-export, dynamic import, `new Worker`/`SharedWorker`, `serviceWorker.register` or `importScripts` names anything other than a relative path that stays inside `web/shim/` and is a shim file or generated glue (`web/shim/gen/<crate>/<crate_>.js`). Non-literal forms and `importScripts` always fail |
| `shim-lex-error` | the file cannot be read exactly (below) |
| `layout-gen-stale` | `web/shim/layout.gen.js` differs from its generator: run `cargo xtask gen` and commit it |

It prints each file's count and `shim: <total> / 300 lines`.

**The `/` rule.** The lexer never guesses whether `/` starts a regular expression, because a wrong
guess could hide code inside what it took for a comment. A `/` that is not `//` or `/*` is accepted
only as division: on the same line as, and right after, an identifier that is not a keyword, a
number, `]`, or a `)` that does not close `if (…)`, `while (…)` and similar. Anything else fails
with `AmbiguousSlash` and its line. Also rejected: U+2028/U+2029 and a lone `\r`, `<!--`, `-->`,
`#!` at the start, `\` or non-ASCII characters outside strings and comments, unterminated
comments, strings and templates, and an unmatched `)`.

| Rejected | Write instead |
|---|---|
| `const re = /a+b/;` | `const re = new RegExp("a+b");` |
| `if (x) /a/.test(s);` | `if (x) new RegExp("a").test(s);` |
| `const h = total\n  / 2;` | `const h = total / 2;` |
| `return /x/.test(s);` | `return new RegExp("x").test(s);` |
| `const r = this / 2;` (keyword before `/`) | `const self = this; const r = self / 2;` |
| `` const v = `a`/2; `` | `` const t = `a`; const v = t / 2; `` |

### `ci:dep-audit`

| Rule id | Fails when | Fix |
|---|---|---|
| `npm-runtime-dependency` | any `package.json` (outside `target`, `node_modules`, `plans` and dot-directories) has `dependencies`, `peerDependencies`, `optionalDependencies` or `bundle(d)Dependencies` | Remove it: the browser runs no npm code (ADR-0001) |
| `npm-disallowed-dev-dependency` | a `devDependencies` entry is not in `npm_dev_allow` (test tooling only) | Remove it, or propose an addition in review |
| `browser-crate-not-allowed` | a non-workspace crate is reachable from `dash-core-mt` over normal dependencies (wasm32 metadata). The message is the dependency path | Remove the dependency, or add a `[[browser_crate]]` entry with a `reason`; each entry is reviewed against ADR-0001, ADR-0004, ADR-0007 and T01-002 |
| `web-sys-feature` | a member depends on `web-sys` with a feature not listed for it in `[web_sys]` (`"Gpu*"` is a prefix) | List the feature under the member in `[web_sys]` |
| `render-worker-lock` | an identifier `Mutex` or `RwLock` appears in the source (macro bodies included) of a render-worker crate (`dash-scene`, `dash-gpu`, `dash-marks`, `dash-state`; T03-008) | Use the lock-free structures of T03 §4.3, or add a `[[lock_allow]]` entry (`crate`, `file`, `ident`, `reason`) |
| `rust-lex-error` | such a source file cannot be tokenised | Fix the syntax |
| `js-outside-shim` | a `js/mjs/cjs/jsx/ts/tsx/mts/cts` file under `web/` is outside `web/shim/` (T01-001) | Move it into Rust or the shim |
| `third-party-host` | an `http(s)://` or `//host` URL in a web asset (`html, htm, css, js, mjs, cjs, json, webmanifest, svg`) does not start with an `allowed_url_prefixes` entry | Serve the asset from our own origin |
| `shim-file-not-allowed` | a file under `web/shim/` (except `README.md`) is not one of the five T03 §5.1 files | Remove it; new shim files need a design change |
| `shim-unpinned` | a T03 §5.1 file has no pin; the message prints its SHA-256 | Add the pin (below) |
| `shim-pin-mismatch` | a shim file's SHA-256 differs from its pin | Update the pin in the same PR (below) |
| `shim-pin-stale` | a pin names a file that is not in the tree | Remove the pin |
| `layout-gen-stale` | `web/shim/layout.gen.js` (admitted unpinned) differs from its generator | Run `cargo xtask gen` and commit it |
| `generated-unknown` | an entry under `web/shim/gen/` other than the directories `dash-core-mt` and `dash-core-st` (nothing is regenerated then) | Delete it |
| `generated-mismatch` | a file in `web/shim/gen/dash-core-{mt,st}/` is missing from, extra to, or different from a fresh `GenOptions::check` build in `target/gen-check/` | Regenerate with `cargo xtask gen` (or delete `web/shim/gen/`) |

The browser graph includes the Arrow crates of `dash-wire` (#24: `arrow-*`, `flatbuffers` and their
dependencies `ahash`, `bytes`, `chrono`, `const-random`, `getrandom`, `num-*`, `tiny-keccak`,
`crunchy`), each with a reason. `ordered-float` and `spirv` are reported because the native golden
harness enables wgpu's Vulkan backend in the unified graph; they are not in the wasm32 build.

All allow entries need a non-empty `reason`; unknown keys in `ci/*.toml` are errors (exit 2).
A symlinked directory inside an audited tree (`web/`, `web/shim/gen/`, a render-worker crate's
`src/`, or any non-skipped directory searched for `package.json`) is also an error (exit 2): the
audit neither follows it nor skips it, because a server following the link would serve files no
check inspected. Replace it with a real directory. Symlinked files are audited through the link.

**Updating pins.** `ci/shim-pins.toml` has one `[[file]]` (`path`, `sha256`) per shim file present.
After changing a shim file, run `cargo xtask ci dep-audit`, copy the hash from the
`shim-pin-mismatch` or `shim-unpinned` message (or `sha256sum web/shim/<file>.js`), and commit it
with the change. The pin makes every byte of shipped JS a reviewed change: a library pasted into a
shim file changes its hash. `.gitattributes` marks `web/shim/**` as `-text` so checkouts never alter
the pinned bytes.

### `ci:bundle-size`

Measures the brotli size (quality 11, window 24; each file compressed separately, as served) of
every artefact in `ci/bundle-budgets.toml`, and the eager total:

| Artefact | Files | T03 §7.3 row | Budget | Eager |
|---|---|---|---|---|
| `shim` | `web/shim/**/*.{js,mjs,cjs}` except `web/shim/gen/**` | shim (all files) | 8 000 | yes (required) |
| `dash-shell` | `web/shim/gen/dash-shell/**` | `dash-shell.wasm` + glue | 700 000 | yes |
| `dash-core-mt` | `web/shim/gen/dash-core-mt/**` | `dash-core-mt.wasm` + glue | 1 900 000 | yes (required) |
| `dash-core-st` | `web/shim/gen/dash-core-st/**` | `dash-core-st.wasm` + glue | 1 900 000 | no (required) |
| `msdf-atlases-latin` | `web/assets/msdf/latin/**` | MSDF atlases (Inter + JetBrains Mono, Latin) | 250 000 | no |
| `dash-editor` | `web/shim/gen/dash-editor/**` | `dash-editor.wasm` | 600 000 | no |
| `dash-rooms-admin` | `web/shim/gen/dash-rooms-admin/**` | `dash-rooms-admin.wasm` | 500 000 | no |
| `dash-geo` | `web/shim/gen/dash-geo/**` | `dash-geo.wasm` | 800 000 | no |
| `workbench-satellite` | each `web/shim/gen/dash-wb-*` directory, separately | Each workbench satellite | 400 000 | no |
| `chrono-tz-slice` | each `web/assets/tz/*.bin`, separately | `chrono-tz` slice | 40 000 | no |
| Eager total | sum of the eager rows | **Eager total** | 2 600 000 | |

Sizes are bytes (1 KB = 1000 bytes). A module's row covers its whole `gen/<crate>/` directory:
`.wasm`, glue and `snippets/`. A table is printed and added to the job's step summary.

**Modes.** `mode = "enforce"` (committed since #23): over budget fails
(`error[bundle-over-budget]`), and an absent artefact marked `required = true` fails
(`bundle-artefact-absent`); `shim`, `dash-core-mt` and `dash-core-st` are required, so run
`cargo xtask gen` (or `ci wasm`) before the gate locally. `mode = "report"` would only warn. Per-crate
(`twiggy`) sizes and the +2 %-per-PR growth check come once `main` has a size baseline (T05 §7.1).

### `ci:design-check`

Copies `designs/` into a temporary directory, runs `python3 -I designs/tools/check.py --write`
there, and compares the regenerated `traceability.md` with the committed one. The working tree is
never modified.

| Rule id | Fails when | Fix |
|---|---|---|
| `design-check-failed` | `check.py` reports errors (broken links or anchors, ID problems); the message lists its `error:` lines | Fix the design text |
| `traceability-stale` | the committed `designs/traceability.md` is not what `--write` generates | Run `python3 -I designs/tools/check.py --write` and commit |

### Build tools and generation

`cargo xtask tools` installs, idempotently, what `ci/tools.toml` pins: the nightly toolchain for
`dash-core-mt` (with `rust-src` and the wasm32 target), `wasm-bindgen-cli` at the `Cargo.lock`
version into `target/tools/bin/`, and binaryen's `wasm-opt` into `target/tools/binaryen-<v>/`. The
binaryen tarball is checked against its pinned SHA-256; a mismatch deletes it and fails (exit 2).

`cargo xtask gen` builds both artefacts of the one `dash-core-mt` crate:

| Artefact | Toolchain | Flags | Memory (checked) |
|---|---|---|---|
| `dash-core-mt` | pinned nightly, `-Z build-std=panic_abort,std` | `+atomics,+bulk-memory,+mutable-globals,+simd128`; linker: `--shared-memory --import-memory --max-memory=2147483648` and the TLS exports wasm-bindgen's threads need | imports one shared memory, max 32 768 pages |
| `dash-core-st` | the repository's stable toolchain | none | defines and exports its own, unshared memory |

Each is then bound (`wasm-bindgen --target web --no-typescript`), optimised (`wasm-opt -O3`) and
checked, and `web/shim/gen/<artefact>/` is replaced. A memory that does not match fails `gen`. The
build environment is cleaned (`RUSTFLAGS`, `RUSTUP_TOOLCHAIN`, `CARGO_TARGET_DIR` …) so the output
is reproducible: `ci:dep-audit` and `ci:probe-absent` rebuild into `target/gen-check/` and compare.

| Options | Web root | Cargo target dirs | Probe | Writes `layout.gen.js` |
|---|---|---|---|---|
| `gen` | `web/` | `target/mt`, `target/st` | no | when stale |
| `ci wasm` | `web/` | `target/mt`, `target/st` | no | no |
| `gen --test`, `ci e2e` | `target/web-test/` (copy of `web/`) | `target/mt-probe`, `target/st-probe` | yes | no |
| `ci probe-absent`, `ci dep-audit` | `target/gen-check/` (copy of `web/`) | `target/mt`, `target/st` | no | no |

`cargo xtask serve` serves a directory (default `web/`; a relative `--root` is from the repository
root) on `localhost` (default port 8080), one request at a time, with COOP `same-origin` and COEP
`require-corp` (dropped by `--no-isolation`), CORP `same-origin`, the T03 §5.7 CSP,
`Cache-Control: no-cache` and `X-Content-Type-Options: nosniff`. Only `GET` and `HEAD` (else 405);
`/` is `index.html`; a path with `%`, `\` or a `..` segment, a directory or a missing file is 404.

### `ci:probe-absent`

`cargo xtask ci probe-absent` deletes `target/gen-check/`, builds a fresh release of both artefacts with default features (so a
`default = ["probe"]` would be caught), and never reads `web/shim/gen/`.

| Rule id | Fails when |
|---|---|
| `probe-artefact-missing` | one of the four artefact files (`dash_core_{mt,st}.js`, `dash_core_{mt,st}_bg.wasm`) is absent or empty |
| `probe-present` | a file under `target/gen-check/shim/` contains the probe marker `__dashProbe` (T03-024) |

### `e2e`

`cargo xtask ci e2e` runs: (1) `cargo xtask gen --test`; (2) both `_bg.wasm` of the test build must contain the probe marker,
else `probe-marker-undetected` (the scanner of `probe-absent` would miss a probe); (3) deletes
`e2e/test-results/` and runs `npx playwright test` in `e2e/` (a failing spec fails the gate; no
`npx` is an error); (4) always checks the interaction traces the specs wrote:

| Rule id | Fails when |
|---|---|
| `long-task-trace-missing` | `e2e/test-results/traces/long-tasks-<p>.json` is missing for `webgpu`, `webgl2`, `noiso` or `line-1e8` (the `bench:frame-line-1e8` loop) |
| `main-thread-long-task` | a main-thread task in the interaction window took > 16 ms of thread time or > 50 ms of wall time (PRF-005, until the reference lab exists); the message gives the project, `ts`, `dur` and `tdur` |
| `frame-report-missing` | `e2e/test-results/traces/frame-line-1e8.json` (the bench report) is missing |
| `frame-report-short` | the bench report has fewer than 10 frame intervals |

With a report of 10 or more intervals the gate prints its summary (frames, p50, p95, p99, max, over
50 ms) and the machine-B verdict of PRF-001/PRF-002: **report only** until the reference lab exists
(T05 §7.1).

A trace the detector cannot judge (no renderer main thread, no input, no task in the window, no
thread time) is an error, not a pass. Playwright (`e2e/playwright.config.ts`) starts two dev servers
on `target/web-test/` (port 8787 isolated, 8788 `--no-isolation`) and runs four Chromium projects,
selected by tag: `webgpu` (SwiftShader WebGPU), `webgl2` (no WebGPU adapter), `nogpu` (no GPU at
all) and `noiso` (not isolated). The specs and what each mode must show are described in
[Browser runtime](../runtime/browser-runtime.md). The report and traces are uploaded as the
`e2e-report` artefact of the CI run.

## Proving a gate fails (T05-002)

Every gate has a seeded, committable violation, and the marker its failing log must contain:

| Gate | Seed | Marker |
|---|---|---|
| `fmt` | creates `crates/dash-tokens/tests/seeded_fmt.rs`, badly formatted | `seeded_fmt` |
| `build` | appends `compile_error!("seeded violation")` to `crates/dash-tokens/src/lib.rs` | `seeded violation` |
| `clippy` | creates a test file with a needless `return` | `needless_return` |
| `test` | creates a failing test | `seeded violation` |
| `wasm` | makes `dash-core-mt` use `std::os::unix` | `unix` |
| `probe-absent` | sets `default = ["probe"]` in `crates/dash-core-mt/Cargo.toml` | `probe-present` |
| `bundle-size` | adds an incompressible `web/shim/seeded-size.js` (the config is already `enforce`) | `bundle-over-budget` |
| `design-check` | appends a broken link to T01 | `seeded-missing.md` |
| `shim-lint` | creates `web/shim/seeded.js` with `eval` | `shim-forbidden-token` |
| `golden` | replaces `const PYRAMID_B: u32 = 16u;` with `8u` in `crates/dash-marks/src/line_common.wgsl` (the GPU walk no longer matches the pyramid) | `gpu_records_match_cpu` |
| `dep-audit` | creates `web/package.json` with a runtime dependency | `npm-runtime-dependency` |
| `e2e` | replaces the Static message in `web/index.html` | `gpu_disabled_shows_fallback` |

`cargo xtask seed <gate-id>` refuses to overwrite an existing file or a second seed for the same
gate, and records exactly what it wrote in `target/xtask-seed/<gate-id>.json`.
`cargo xtask unseed <gate-id>` undoes exactly that record: it restores modified files, deletes
created files and removes the directories it created only if they are empty. It refuses (and
changes nothing) if a seeded file was edited since seeding. It never runs `git clean` or touches
other files.

To prove a gate in CI, branch from a green head, run `cargo xtask seed <gate-id>`, commit, and open
a draft PR against that branch with "do not merge" in the title. The run must show step
`ci <gate-id>` as failed, every earlier step of its job as passed, and the marker in the failed log.
Record the run in the PR, then close the draft PR and delete its branch.
