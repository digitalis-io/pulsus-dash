# Local dev stack

The dev stack runs the server on a workstation against Postgres in containers. `dev/compose.yaml`
describes the containers, and `make dev-*` targets drive them, reading local settings from the
untracked file `dev/local.env`. The same compose file backs `make itest-local`, which runs the
server integration tests on PostgreSQL 15 and 16
([ADR-0015](../../designs/adr/0015-go-bff.md)), and the `ci:dev-stack` smoke test
([T05 §7.1](../../designs/technical/T05-testing-and-performance.md)).

There is no identity provider in the stack. Authentication is deferred (decision D12 in
[the designs index](../../designs/README.md)): until M-UI6, the server serves a fixed local
principal ("Local user", role admin) of the bootstrap organisation
([T06](../../designs/technical/T06-bff-architecture.md) §4.11). An IdP joins `dev/compose.yaml`
with sign-in.

## Prerequisites

| Tool | Version |
|---|---|
| Docker Compose v2, or a compatible `compose` command | any current release; set `COMPOSE` to use another command, for example `make dev-up COMPOSE="podman compose"` |
| Go | 1.27.4 (the `toolchain` line of `server/go.mod`; see [build and CI](build-and-ci.md#server-toolchain)) |
| Node.js | 24 (for the web client; see [build and CI](build-and-ci.md#toolchain)) |

The smoke test also uses `docker` (for `docker ps` and `docker volume inspect`) and `curl`.

## What runs

| Service | Image | Host port | Data | Started by |
|---|---|---|---|---|
| `pg16` | `postgres:16.16-alpine3.24`, pinned by digest | `127.0.0.1:55432` (`DEV_PG16_PORT`) | volume `pg16-data`, kept across `dev-down` | `dev-db`, `dev-up`, `itest-local` |
| `pg15` | `postgres:15.20-alpine3.24`, pinned by digest | `127.0.0.1:55433` (`DEV_PG15_PORT`) | `tmpfs`, gone when the container stops | `itest-local` only (profile `itest`) |

The digests are the same as those of the `itest` CI job. The compose project is `pulsus-dash`
(`DEV_PROJECT`).

The health check is `pg_isready` over TCP to `127.0.0.1:5432` (database `pulsus_dash` for `pg16`,
`postgres` for `pg15`). While the image runs its init scripts, its temporary server listens only on
the Unix socket, so a container counts as healthy only once the scripts are done and the real
server accepts TCP connections. `up --wait`, and so `make dev-db`, returns only then.

On an empty `pg16-data` volume, the image runs two init scripts:
1. `server/deploy/postgres-roles.sql` creates the roles `pulsus_owner`, `pulsus_app` and
   `pulsus_maint` ([the database page](../server/database.md));
2. `dev/postgres-init.sql` creates the database `pulsus_dash`, owned by `pulsus_owner`.

Both containers use **trust authentication**: any local connection is accepted without a
password. That is safe only because the ports bind to the loopback address. Never use this
setting, or this compose file, outside development.

## `dev/local.env`

`dev/local.env` holds the server's settings for the dev stack. It is listed in `.gitignore` and
must never be committed. It is the **only** place where the real PulsusDB base URL goes. There is
no tracked copy. Create it with this content, then put your PulsusDB base URL in
`PULSUS_DASH_DATASOURCE_URL`:

```sh
# dev/local.env — untracked. Never commit it.
PG_APP_URL=postgres://pulsus_app@localhost:55432/pulsus_dash?sslmode=disable
PG_OWNER_URL=postgres://pulsus_owner@localhost:55432/pulsus_dash?sslmode=disable
PULSUS_DASH_POSTGRES_APP_URL_REF=env:PG_APP_URL
PULSUS_DASH_POSTGRES_OWNER_URL_REF=env:PG_OWNER_URL
PULSUS_DASH_DATASOURCE_URL=http://localhost:3100   # your PulsusDB base URL
# PULSUS_DASH_DATASOURCE_CREDENTIALS_REF=env:PULSUSDB_BASIC   and   PULSUSDB_BASIC=user:password
PULSUS_DASH_LOG_FORMAT=text
```

The make targets read it with `set -a; . dev/local.env; set +a`, so it holds plain `KEY=value`
lines. The `PULSUS_DASH_*` names are the server's configuration keys
([the server page](../server/README.md#configuration)); unknown `PULSUS_DASH_*` names are errors.
The Postgres URLs are secret references (`env:NAME`), as T19-010 requires
([T19](../../designs/technical/T19-deployment.md)). `DEV_ENV_FILE` points the targets at another
file.

The datasource URL is a seed setting: `migrate` stores it as the first organisation's tenant
binding on an empty database, and ignores it afterwards. To change it, run `make dev-reset` and
`make dev-up` again.

`make no-pulsusdb-host` also reads `dev/local.env`. The host of `PULSUS_DASH_DATASOURCE_URL` joins
the forbidden-host list, so a local run catches a tracked copy of your real host
([`ci:no-pulsusdb-host`](build-and-ci.md#ci-no-pulsusdb-host)).

## Make targets

All targets run from the repository root.

| Target | What it does | Needs `dev/local.env` |
|---|---|---|
| `make dev-up` | `dev-db`, then `dev-migrate`, then `build/pulsus-dash serve` in the foreground on `0.0.0.0:8080` (the default `server.listen`). Ctrl-C stops the server; Postgres keeps running | yes |
| `make dev-db` | starts `pg16` and waits until it is healthy (`up -d --wait`) | no |
| `make dev-migrate` | `make server-build`, then `build/pulsus-dash migrate`: applies the migrations and, on an empty database, seeds the organisation and its tenant binding | yes |
| `make dev-down` | stops and removes the containers; the `pg16-data` volume and its data stay | no |
| `make dev-reset` | removes the containers and the volume; the next `dev-up` runs the init scripts and seeds again | no |
| `make itest-local` | starts `pg16` and `pg15` in their own project `pulsus-dash-itest` on ports 57432 and 57433 (`ITEST_PROJECT`, `ITEST_PG16_PORT`, `ITEST_PG15_PORT`), runs `make itest` against both, and removes the containers and volume on every exit, pass or fail. It never touches the dev volume | no |
| `make dev-smoke` | `dev/smoke.sh`, then `dev/smoke-selftest.sh` (`ci:dev-stack`, below) | no |

`dev-up` and `dev-migrate` run their steps in order inside their recipes, so the order also holds
with `make -j`: the settings file is checked first, then Postgres is started and waited for, then
the migrations run, then the server starts. Without the settings file, `dev-up` and `dev-migrate`
stop before starting anything:

```text
dev/local.env is missing: create it as described in docs/development/dev-stack.md
```

## Smoke test (`ci:dev-stack`)

`dev/smoke.sh` checks the whole stack. It uses its own compose project `pulsus-dash-smoke`, port
56432 and a generated settings file in a temporary directory, so a developer's stack is not
touched. The server listens on `localhost:58080`, and its datasource URL is `http://localhost:9`,
where nothing listens: readiness never depends on PulsusDB
([T06-026](../../designs/technical/T06-bff-architecture.md)).

| Step | Passes when |
|---|---|
| 1 | `make dev-db` succeeds |
| 2 | `make dev-migrate` prints `seeded organisation "default" with tenant binding "default"` |
| 3 | the server, started directly with `exec`, answers `GET /readyz` with `"status":"ready"` within 30 s |
| 4 | after `SIGTERM` it exits 0 within 20 s, and nothing listens on port 58080 |
| 5 | after `make dev-down` no container is left and the `pulsus-dash-smoke_pg16-data` volume still exists |
| 6 | after `make dev-db` and `make dev-migrate` the output says `organisation already seeded` |
| 7 | after `make dev-reset` the volume is gone |

A failed step prints `smoke step <n> failed` and exits 1. A cleanup trap runs on every exit: it
stops the server (`SIGTERM`, up to 10 s, then `SIGKILL`), removes the project's containers and
volume, and deletes the temporary directory. `COMPOSE` sets the compose command for the script
too.

`dev/smoke-selftest.sh` checks that nothing is left behind after the normal run. It then runs
`SMOKE_FAIL_AT=3 dev/smoke.sh`, which exits 1 right after step 3 with the server running, and checks
again: no listener on port 58080, no `pulsus-dash-smoke` container and no volume.

## Using the client

After `make dev-up`, the server runs on port 8080. The web client's dev server proxies `/api` to it
(`PULSUS_DASH_DEV_BFF`, default `http://localhost:8080`; see [the client page](../client/README.md)).
`npm run dev` with `VITE_API_MODE=http` uses the server instead of the stub API. The server does
not yet serve the client or the bootstrap API: those come with #59 Part B.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Compose fails to bind port 55432 | Another Postgres or stack uses it. Set `DEV_PG16_PORT` (and `DEV_PG15_PORT`) to free ports, for example `make dev-up DEV_PG16_PORT=55532`, and change the port in `PG_APP_URL` and `PG_OWNER_URL` in `dev/local.env` to match |
| `migrate` fails with `database "pulsus_dash" does not exist`, or a role is missing | The init scripts run only on an empty volume. A volume created before they existed, or by another version, keeps its old state. `make dev-reset` removes it, and the next `make dev-up` initialises it again. This deletes the dev data |
| A changed `PULSUS_DASH_DATASOURCE_URL` has no effect | The binding is seeded once. `make dev-reset`, then `make dev-up` |
| `serve` exits at start-up with a Postgres error | Run `make dev-migrate` first (`make dev-up` does), and check that the URLs in `dev/local.env` use port `DEV_PG16_PORT` |

## Designs

- [ADR-0015](../../designs/adr/0015-go-bff.md): the Go server and its `itest` against the dev
  compose stack.
- [T05 §7.1](../../designs/technical/T05-testing-and-performance.md): the `ci:dev-stack` gate.
- [T19](../../designs/technical/T19-deployment.md) T19-010: secrets as references; the private
  PulsusDB URL only in an untracked file.
- Decision D12 in [the designs index](../../designs/README.md): no IdP until M-UI6.
