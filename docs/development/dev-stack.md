# Dev stack

Running `pulsus-dash` locally: a compose stack with Postgres and an OIDC IdP, the binary on top,
and the itests and e2e suites that use the same stack.

Implements the local stack of [T19](../../designs/technical/T19-deployment.md) and the itest
harness of [T05 §7.1](../../designs/technical/T05-testing-and-performance.md#71-gate-catalogue)
(`itest:rls-isolation`, `itest:no-extensions`). What the binary does: [Server architecture](../server/architecture.md);
its settings: [Server configuration](../server/configuration.md).

## Prerequisites

- Everything in [Build, test and CI](build-and-ci.md#prerequisites).
- Docker with the compose plugin (`docker compose`).
- A PulsusDB to read from. There is **no local PulsusDB** in the stack (T06-017): Dash only reads
  it, and readiness does not need it.

## The PulsusDB URL: `dev/local.env`

The PulsusDB base URL is never committed. Put it in the untracked (git-ignored) `dev/local.env`:

```bash
# dev/local.env
PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL=https://pulsusdb.example:8080
# optional: PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__SCOPE_ORG_ID=tenant-a
```

Format: `KEY=VALUE` lines; `#` comments and blank lines are ignored; one pair of surrounding `"`
is stripped. A variable already set in the environment wins over the file. Without the URL,
`dev up` stops at the server start with the "missing required setting" error.

## Commands

| Command | What it does |
|---|---|
| `cargo xtask dev up [--port N] [--assets DIR]` | Loads `dev/local.env`, renders the Dex config, `docker compose -p <project> -f dev/compose.yaml up -d --wait postgres idp`, waits for the IdP (60 s). Without `--assets` it installs the build tools and builds both core artefacts into `web/` (`cargo xtask tools`, `cargo xtask gen`). Then `cargo build -p pulsus-dash`, `pulsus-dash migrate --config dev/pulsus-dash.dev.yaml`, and replaces itself with `pulsus-dash --role all --config dev/pulsus-dash.dev.yaml` listening on `localhost:N` (default 8080) with `public_url` `http://localhost:N`, serving `DIR` (default `web/`). Unix only |
| `cargo xtask dev down` | `compose down` (the database volume is kept) and deletes `target/dev/<project>/` |
| `cargo xtask dev reset [--port N] [--assets DIR]` | `compose down -v` (deletes the database), deletes `target/dev/<project>/`, then `up` |
| `cargo xtask dev sqlx-prepare` | Refreshes the committed `.sqlx/` query cache: brings the stack up, creates the scratch database `sqlx_prepare`, migrates it with sqlx-cli, then runs `cargo sqlx prepare --workspace` against it. Run it after changing a query or a migration and commit `.sqlx/`. Needs `cargo xtask tools sqlx-cli` |

Stop the server with Ctrl-C (it shuts down gracefully); the stack keeps running until `dev down`.

## Stack and ports

| Service | Image | Host port (loopback only) | Notes |
|---|---|---|---|
| `postgres` | `postgres:16` | `$DASH_PG_PORT` (55432) | trust authentication; roles from `server/crates/dash-store/sql/roles.sql`; database `pulsus` owned by `pulsus_owner`; volume `pg16` |
| `idp` | `ghcr.io/dexidp/dex:v2.46.1` | `$DASH_IDP_PORT` (5556) | issuer `http://localhost:<port>/dex`, in-memory storage |
| `postgres15-vanilla` | built from `dev/postgres15-vanilla/` | `$DASH_PG15_PORT` (55433) | profile `itest` only: Postgres 15 with every extension but `plpgsql` deleted |

The compose project is `$DASH_DEV_PROJECT` (default `pulsus-dash-dev`), so several checkouts can
run side by side with different projects and ports. When `DASH_PG_PORT` is not 55432, `dev up`
points the dev configuration at it through `PULSUS_DASH_POSTGRES__URL_REF` and
`PULSUS_DASH_POSTGRES__OWNER_URL_REF`.

`dev/pulsus-dash.dev.yaml` uses literal Postgres URLs (`allow_inline_secrets: true`, dev only):
the dev Postgres trusts loopback connections and has no passwords. Never use it outside a laptop.

## The dev user

Dex has one static user, `dev@example.com` (username `dev`), and one public client
`pulsus-dash-dev` (redirects `http://localhost:8080/auth/callback` and
`http://localhost:8787/auth/callback`). Its password is random: `dev up` generates 24 characters
once, keeps them in `target/dev/<project>/dev-user.txt` and writes only the bcrypt hash into the
rendered `target/dev/<project>/dex.yaml`. Login itself arrives with #40.

## Itests and e2e locally

`cargo xtask ci itest` runs the whole itest gate on its own project `pulsus-dash-itest` (ports
56432, 56433 and 6556): it starts the stack with the `itest` profile, runs the ignored itests of
`dash-store` and `pulsus-dash` on Postgres 16 and again on vanilla Postgres 15, checks the IdP's
discovery document, checks the `.sqlx` cache against a migrated scratch database, and always takes
the stack down (`down -v`). It needs `cargo xtask tools sqlx-cli`.

To run the itests against a Postgres you already have (superuser URL, roles are created by the
tests):

```bash
DASH_ITEST_PG_ADMIN_URL=postgres://postgres@localhost:56432/postgres DASH_ITEST_EXPECT_VANILLA=0 \
  cargo test -p dash-store -p pulsus-dash -- --ignored
```

Each test creates and drops its own database `itest_<uuid>`.

`cargo xtask ci e2e` starts the binary on port 8787 with `cargo xtask dev up --assets
target/web-test --port 8787` (the default project and ports) and the header-stripping dev server
on 8788, then runs the `dev up` flow test on port 8789 with project `pulsus-dash-devup` (ports
57432, 57433, 7556) from a clean `web/shim/gen/`. Set `PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL`
(any reachable-or-not URL works; CI uses `http://pulsusdb.invalid:9`).

## Limits

- No local PulsusDB; no login yet; the dev user is for #40.
- `dev up` replaces itself with the server, so it needs a Unix host.
