# Build, test and CI

How to build and check the web client locally, and what CI runs. The client is TypeScript, React and
Vite in `client/` ([ADR-0014](../../designs/adr/0014-typescript-react-web-client.md)). The gate IDs
are those of the [T05 §7.1 gate catalogue](../../designs/technical/T05-testing-and-performance.md).

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
| `npm run typecheck` | `tsc` over `tsconfig.app.json` (browser code) and `tsconfig.node.json` (scripts, ESLint plugin, end-to-end tests, configs) | `ci:typecheck` |
| `npm test` | Vitest: project `node` (scripts and config) and project `dom` (jsdom, Testing Library) | `unit:*` |
| `npm run e2e` | Playwright against `npm run build && npm run preview` | `e2e:*`, `bench:startup` |
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

The rules of each checker are described where they are used: token-lint in
[the client page](../client/README.md#tokens-and-token-lint), the dependency checks and the
build-origin check in [the supply chain page](../client/supply-chain.md).

## Tests

- **Unit and component tests** (`npm test`) sit next to the code as `*.test.ts(x)`. Component tests
  render the whole app with `src/test/renderApp.tsx` (`renderApp(url, { api, now, timeZone,
  queryClient })`) on a memory router, with the stub API and a fixed clock
  (`T` = 2026-11-19 13:03 UTC, zone Europe/London). Its query client has `retry: false`; tests of
  the production retry pass `createQueryClient()`.
- **End-to-end tests** (`client/e2e/*.spec.ts`) run in Chromium, Firefox and WebKit against
  `vite preview` with the production CSP. `Date.now()` is frozen with `page.clock.setFixedTime(T)`.
  To run one engine locally: `npm run e2e -- --project=chromium`.
- **Keyboard coverage** (`e2e/keyboard.spec.ts`, part of `e2e:a11y-rooms`): see
  [the client page](../client/README.md#keyboard-coverage).
- **`bench:startup`** (`e2e/perf-cold-load.spec.ts`, Chromium only, report only, PRF-008): 20 cold
  loads of `/t/demo/boards`, time to the `shell-ready` performance mark; p50 and p75 are written to
  `test-results/prf-008.json` and added as a test annotation. There is no threshold.

## CI

`.github/workflows/client.yml` runs on pull requests that touch `client/`, `design/tokens.toml` or
the workflow, and on pushes to `main`. Actions are pinned by commit SHA, the token is read-only and
no secrets are used.

| Job | Steps (gate) |
|---|---|
| `check` | `npm ci` (`ci:lockfile` install) → `check:lockfile` (`ci:lockfile`) → `lint` (`ci:lint-ts`) → `typecheck` (`ci:typecheck`) → `tokens -- --check` and `token-lint` (`ci:token-lint`) → `test` (unit) → `build` (with `VITE_GIT_SHA`) → `size` (`ci:bundle-size`) → `origins` (`ci:dep-audit`, build origins) → `audit` (`ci:dep-audit`, `ci:npm-audit`) |
| `e2e` | after `check`, one job per engine (`chromium`, `firefox`, `webkit`): `npm ci`, install that browser with its system dependencies, `npm run e2e -- --project=<engine>`; the HTML report and `test-results/` are uploaded for 14 days. CI retries a failed test once |

The end-to-end jobs need the browsers' system libraries, which `--with-deps` installs on the CI
image. On a workstation without them, install the packages Playwright names, or run only the
engines whose libraries are present.
