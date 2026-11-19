# Server configuration

How `pulsus-dash` is configured: the layers, every key, secret references, the PulsusDB base URL,
credentials, and the errors it reports. The binary validates everything before it connects to
anything; any error exits 2 with `pulsus-dash: configuration error: <message>` on stderr.

Implements [T06-019 and T06 §4.9](../../designs/technical/T06-bff-architecture.md),
[T19-010](../../designs/technical/T19-deployment.md) and the output rule of
[T18-030](../../designs/technical/T18-security.md). Architecture: [Server architecture](architecture.md).

## Layers (T06-019)

Lowest first; a later layer overrides an earlier one key by key.

| Layer | Rule |
|---|---|
| YAML file (`--config PATH`) | parsed to a mapping (an empty file is `{}`) |
| Environment | every `PULSUS_DASH_*` variable, in sorted order. The rest of the name is split on `__` and lower-cased: `PULSUS_DASH_POSTGRES__URL_REF` sets `postgres.url_ref`. A segment of digits is a list index: `PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL` sets `datasources_bootstrap[0].url`; an index equal to the list length appends, a larger one is an error ("list index N skips entries"). The value is parsed as YAML (`true`, `42`, `[a, b]`); an empty value means "unset" |
| Command line | `--role a,b` sets `roles` |

Configuration is **strict**: an unknown key in the file, or a `PULSUS_DASH_*` variable that maps
to no key, is an error naming the key and where it came from:

```
pulsus-dash: configuration error: unknown configuration key `postgres.pool_size` (in dev/x.yaml)
pulsus-dash: configuration error: unknown configuration key `listen_port` (from environment variable PULSUS_DASH_LISTEN_PORT)
```

## Keys

| Key | Type | Default | Rules |
|---|---|---|---|
| `roles` | list of strings | `[all]` | each one of `all`, `api`, `worker`, `evaluator`, `notifier`, `ai`; only `all` is implemented (T06-003) |
| `listen` | `host:port` | `0.0.0.0:8080` | ends in `:<port>`; port `0` picks a free port (logged) |
| `public_url` | URL | none | `http`/`https` with a host; no user info, query or fragment. Enables the [self-check](architecture.md#public-url-self-check-t19-002); `https` adds `upgrade-insecure-requests` to the CSP |
| `allow_inline_secrets` | bool | `false` | allows literal secrets; **dev only** (T19-010) |
| `postgres.url_ref` | secret reference | required by `serve` | the `pulsus_app` connection; must resolve to a `postgres://` or `postgresql://` URL |
| `postgres.owner_url_ref` | secret reference | required by `migrate` | the `pulsus_owner` connection, used only by `migrate` |
| `postgres.pool_max` | integer | `32` | 1–1024 |
| `postgres.connect_timeout_ms` | integer | `2000` | 100–60000; also the pool's acquire timeout |
| `assets.dir` | path | `web` | an existing directory (relative to the working directory) |
| `log.filter` | string | `info` | a `tracing` filter (`info`, `dash_store=debug,info`) |
| `log.format` | `text` \| `json` | `text` | logs go to stderr |
| `datasources_bootstrap` | list | `[]` | exactly one entry in this release |
| `datasources_bootstrap[0].url` | URL | required by `serve` | **the PulsusDB base URL** (below) |
| `datasources_bootstrap[0].org_slug` | string | `default` | `^[a-z0-9-]{1,40}$`; the org created on first run |
| `datasources_bootstrap[0].slug` | string | `default` | `^[a-z0-9-]{1,40}$`; the binding's slug |
| `datasources_bootstrap[0].database` | string | none | 1–128 characters; empty = none |
| `datasources_bootstrap[0].scope_org_id` | string | none | `^[A-Za-z0-9_.-]{1,150}$`, sent as `X-Scope-OrgID`; empty = header omitted |
| `datasources_bootstrap[0].credentials_ref` | secret reference | none | `user:password` for PulsusDB Basic auth (below) |

`serve` validates `roles` first, then the keys in table order, and reports the first error.
`migrate` validates `roles`, `postgres.*` and `log.*` only; it does not need the PulsusDB URL.

## The PulsusDB base URL

`datasources_bootstrap[0].url` is where Dash reads telemetry. It is seeded into the default org's
binding on the first run; after that Postgres owns the binding and a changed value is only warned
about. Set it in the file or the environment:

```yaml
datasources_bootstrap:
  - org_slug: default
    slug: default
    url: https://pulsusdb.example:8080
    scope_org_id: tenant-a        # optional
```

```bash
export PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL=https://pulsusdb.example:8080
```

Without it `serve` exits 2:

```
pulsus-dash: configuration error: missing required setting `datasources_bootstrap[0].url`: the PulsusDB base URL; set it in the --config file or PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL
```

Readiness does not depend on PulsusDB (T06-026): the server is ready with an unreachable URL.
The real PulsusDB host is never committed; `ci:no-pulsusdb-host` enforces it (see
[Build, test and CI](../development/build-and-ci.md)).

## Credentials

PulsusDB authentication is optional and absent by default. Without `credentials_ref` no auth
header is sent (the dev mode). With it, the reference must resolve to `user:password`; the pair is
resolved at start-up into memory only. It is never written to Postgres, never logged and prints as
`BasicCredentials { *** }`. Sending it is the PulsusDB client's job (#41). Storing credentials in
Postgres waits for the secrets store (T18 §4.8).

## Secret references (T19-010)

`postgres.url_ref`, `postgres.owner_url_ref` and `datasources_bootstrap[0].credentials_ref` take a
reference, classified in this order:

| Form | Resolves to | Error |
|---|---|---|
| `env:NAME` | the variable's value | unset or empty: "environment variable NAME is not set" |
| `file:PATH` | the file's content, one trailing newline removed | "cannot read the referenced file" |
| `vault:…`, `aws-sm:…`, `gcp-sm:…`, `azure-kv:…` | — | "reference scheme `<s>` is not supported in this release; use env: or file:" |
| anything else | the literal | refused unless `allow_inline_secrets: true`: "literal secrets are refused; use env: or file:, or set allow_inline_secrets: true (dev only)" |

Production example (Kubernetes secrets mounted as files or env):

```yaml
postgres:
  url_ref: "file:/var/run/secrets/pulsus/app-url"
  owner_url_ref: "env:PULSUS_OWNER_URL"
datasources_bootstrap:
  - url: https://pulsusdb.example:8080
    credentials_ref: "file:/var/run/secrets/pulsus/pulsusdb-basic"
```

## Output rule

No error, log line or debug print contains a secret value, a Postgres URL, the PulsusDB base URL
or any configured URL path. URL errors use fixed reasons ("not a valid URL", "must use http or
https", "must not contain user info", "must not contain a query or fragment", "must have a host");
type errors have the offending value replaced by `<value>`. `public_url` is logged only as its
origin; store errors are logged as kind and SQLSTATE.

## Errors

| Error | Message |
|---|---|
| Unknown key | ``unknown configuration key `<key>` (in <file>)`` or ``(from environment variable <VAR>)`` |
| Missing | ``missing required setting `<key>`: <what>; set it in the --config file or <VAR>`` |
| Invalid | ``invalid value for `<key>` (<source>): <reason>`` (no source for a default) |
| Role | ``role `<role>` is not implemented in this build; only `all` is supported (T06-003)`` |
| Unreadable file | `cannot read configuration file <path>: <io error kind>` |
| Bad YAML | `cannot parse configuration (<source>): invalid YAML at line L column C` |

## Production roles

Run the database roles script once per cluster as a superuser, create the database owned by
`pulsus_owner`, then run `pulsus-dash migrate` (a pre-upgrade job) before `pulsus-dash`:

```bash
psql -U postgres -f server/crates/dash-store/sql/roles.sql
psql -U postgres -c "CREATE DATABASE pulsus OWNER pulsus_owner" \
                 -c "GRANT CONNECT ON DATABASE pulsus TO pulsus_app, pulsus_maint"
pulsus-dash migrate --config /etc/pulsus/dash.yaml
pulsus-dash --role all --config /etc/pulsus/dash.yaml
```

The script sets no passwords; set them (or use certificate authentication) out of band.
