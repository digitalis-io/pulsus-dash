# Build, test and CI

How the Cargo workspace is laid out, how to build it for native and the browser, and how every CI
gate works, locally and in GitHub Actions.

Implements [T01-001 and T01-002](../../designs/technical/T01-frontend-architecture.md),
[T03-001 and T03-008](../../designs/technical/T03-browser-runtime.md) (the CI lint) and
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

No Node.js toolchain is needed. Network access is needed only for crates.io.

## Commands

| What | Command |
|---|---|
| Native build of every crate | `cargo build --workspace --locked` |
| Browser build | `cargo build-wasm` → `target/wasm32-unknown-unknown/wasm-release/dash_core_mt.wasm` |
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

Every finding prints as `error[<rule-id>] <path>[:<line>]: <message>`. Under GitHub Actions it is
also emitted as an `::error` annotation, so it shows on the PR diff.

## Layout

| Path | Contents |
|---|---|
| `Cargo.toml` | The one root workspace (`crates/*`, `xtask`), shared package keys and lints |
| `crates/` | Browser, shared (⇄) and test crates: `dash-core-mt` (the core WASM module), `dash-gpu`, `dash-scene`, `dash-marks`, `dash-scales`, `dash-axes`, `dash-tokens`, `dash-wire`; test crates `pulsus-synth`, `dash-golden`, `dash-lab`. Today they are stubs that name their design and implementing issue |
| `server/` | BFF-only crates (M-UI1, T06 §4.1); not created yet |
| `xtask/` | The gate runner and seeds (this page) |
| `ci/` | Gate registry and gate configuration |
| `web/shim/` | The JS shim: only the five T03 §5.1 files may live here |
| `web/shim/gen/` | Git-ignored wasm-bindgen output. None is accepted yet (see `ci:dep-audit`) |

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
(T05-001). `.github/workflows/ci.yml` runs three jobs on every pull request and on pushes to `main`.
Each gate is one step named `ci <gate-id>` that runs `cargo xtask ci <gate-id>`, exactly what you
run locally.

| Gate id | T05 gate | Owner | Job | Checks |
|---|---|---|---|---|
| `fmt` | — | `area:platform` | `rust` | `cargo fmt --all --check` |
| `build` | — | `area:platform` | `rust` | `cargo build --workspace --locked` |
| `clippy` | — | `area:platform` | `rust` | `cargo clippy --workspace --all-targets --locked -- -D warnings`, then the same for `dash-core-mt` on `wasm32-unknown-unknown` |
| `test` | — | `area:platform` | `rust` | `cargo test --workspace --locked` |
| `wasm` | — | `area:platform` | `wasm` | `cargo build-wasm` |
| `bundle-size` | `ci:bundle-size` | `area:rendering` | `wasm` | Brotli size per artefact against T03 §7.3 |
| `dep-audit` | `ci:dep-audit` | `area:platform` | `wasm` | npm, browser crate graph, `web-sys` features, render-worker locks, web assets, shipped JS |
| `design-check` | `ci:design-check` | `area:platform` | `static` | `designs/tools/check.py` and the traceability diff |
| `shim-lint` | `ci:shim-lint` | `area:shell` | `static` | T03-001 on the shim |

The `static` job also runs `python3 -I designs/tools/check.py` on the checkout as its last step,
even when an earlier gate failed.

Which checks are *required* to merge is a repository setting made by the owner; this repository
only defines the checks.

### Fixing a cargo gate

Run the same command locally. `fmt`: run `cargo fmt` on the files you changed. `clippy`: fix the
lint; do not add `allow` attributes without a reason in the code. `wasm`: the crate uses something
that does not exist on `wasm32-unknown-unknown` (for example `std::os::unix`), or a dependency that
does not build for it.

### `ci:shim-lint`

Counts the non-blank, non-comment lines of every `.js`, `.mjs` and `.cjs` file under `web/shim/`
that git tracks or does not ignore (`git ls-files --cached --others --exclude-standard`). Nothing is
excluded by name or location: a file force-added under `gen/` is counted too. It then checks:

| Rule id | Fails when |
|---|---|
| `shim-dir-missing` | `web/shim/` does not exist |
| `shim-line-budget` | the total is over 300 (T03-001) |
| `shim-forbidden-token` | `eval`, `Function` or `innerHTML` appears as a word in code or strings |
| `shim-import` | an import, re-export, dynamic import, `new Worker`/`SharedWorker`, `serviceWorker.register` or `importScripts` names anything other than a relative path that stays inside `web/shim/` and is a shim file or generated glue (`web/shim/gen/<crate>/<crate_>.js`). Non-literal forms and `importScripts` always fail |
| `shim-lex-error` | the file cannot be read exactly (below) |

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
| `generated-js-present` | any file exists on disk under `web/shim/gen/` | Delete it. Generated output is not accepted until #23 adds its regenerate-and-compare check |

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
| `shim` | `web/shim/**/*.{js,mjs,cjs}` except `web/shim/gen/**` | shim (all files) | 8 000 | yes |
| `dash-shell` | `web/shim/gen/dash-shell/**` | `dash-shell.wasm` + glue | 700 000 | yes |
| `dash-core-mt` | `web/shim/gen/dash-core-mt/**` | `dash-core-mt.wasm` + glue | 1 900 000 | yes |
| `msdf-atlases-latin` | `web/assets/msdf/latin/**` | MSDF atlases (Inter + JetBrains Mono, Latin) | 250 000 | no |
| `dash-editor` | `web/shim/gen/dash-editor/**` | `dash-editor.wasm` | 600 000 | no |
| `dash-rooms-admin` | `web/shim/gen/dash-rooms-admin/**` | `dash-rooms-admin.wasm` | 500 000 | no |
| `dash-geo` | `web/shim/gen/dash-geo/**` | `dash-geo.wasm` | 800 000 | no |
| `workbench-satellite` | each `web/shim/gen/dash-wb-*` directory, separately | Each workbench satellite | 400 000 | no |
| `chrono-tz-slice` | each `web/assets/tz/*.bin`, separately | `chrono-tz` slice | 40 000 | no |
| Eager total | sum of the eager rows | **Eager total** | 2 600 000 | |

Sizes are bytes (1 KB = 1000 bytes). A module's row covers its whole `gen/<crate>/` directory:
`.wasm`, glue and `snippets/`. A table is printed and added to the job's step summary.

**Modes.** `mode = "report"` (committed today): over budget is a `warning[bundle-over-budget]`
and the gate never fails; absent artefacts are listed as `absent`. `mode = "enforce"`: over budget
fails (`error[bundle-over-budget]`), and an absent artefact marked `required = true` fails
(`bundle-artefact-absent`). The first PR whose CI build writes `web/shim/gen/dash-core-mt/` switches
to `enforce` and marks what it builds `required` (T05 §7.1).

### `ci:design-check`

Copies `designs/` into a temporary directory, runs `python3 -I designs/tools/check.py --write`
there, and compares the regenerated `traceability.md` with the committed one. The working tree is
never modified.

| Rule id | Fails when | Fix |
|---|---|---|
| `design-check-failed` | `check.py` reports errors (broken links or anchors, ID problems); the message lists its `error:` lines | Fix the design text |
| `traceability-stale` | the committed `designs/traceability.md` is not what `--write` generates | Run `python3 -I designs/tools/check.py --write` and commit |

## Interim gates and when they change

From T05 §7.1:

- `ci:shim-lint`: nothing is excluded by name. `layout.gen.js` would fail `ci:dep-audit` (it is not
  a T03 §5.1 file). Once T03-005's generator exists, `layout.gen.js` is excluded from the count and
  is regenerated and diffed instead.
- `ci:dep-audit`: generated JS under `web/shim/gen/` is rejected until #23 adds the
  regenerate-and-compare check that accepts wasm-bindgen output.
- `ci:bundle-size`: report mode until the first PR whose CI build writes
  `web/shim/gen/dash-core-mt/`. That PR enables `enforce`, marks the artefacts it builds `required`,
  and adds per-crate (`twiggy`) sizes and the +2 %-per-PR growth check.

## Proving a gate fails (T05-002)

Every gate has a seeded, committable violation, and the marker its failing log must contain:

| Gate | Seed | Marker |
|---|---|---|
| `fmt` | creates `crates/dash-tokens/tests/seeded_fmt.rs`, badly formatted | `seeded_fmt` |
| `build` | appends `compile_error!("seeded violation")` to `crates/dash-tokens/src/lib.rs` | `seeded violation` |
| `clippy` | creates a test file with a needless `return` | `needless_return` |
| `test` | creates a failing test | `seeded violation` |
| `wasm` | makes `dash-core-mt` use `std::os::unix` | `unix` |
| `bundle-size` | switches `ci/bundle-budgets.toml` to `enforce` and adds an incompressible `web/shim/seeded-size.js` | `bundle-over-budget` |
| `design-check` | appends a broken link to T01 | `seeded-missing.md` |
| `shim-lint` | creates `web/shim/seeded.js` with `eval` | `shim-forbidden-token` |
| `dep-audit` | creates `web/package.json` with a runtime dependency | `npm-runtime-dependency` |

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
