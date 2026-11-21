# Pulsus Dash server targets (T05 §7.1 gates). Run from the repository root.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

VERSION ?= 0.1.0-dev
# make build: the client's API mode, the commit shown in About, and the binary's path.
API_MODE ?= http
GIT_SHA ?= $(shell git rev-parse HEAD)
OUT ?= $(CURDIR)/build/pulsus-dash
BIN := $(CURDIR)/build/bin
export PATH := $(BIN):$(PATH)

GOLANGCI_VERSION := 2.15.0
GOLANGCI_SHA256 := 9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea
SQUAWK_VERSION := 2.72.0
SQUAWK_SHA256 := a61661808119a82515565503111099b070c869f73698f61cb1785de5d0c8b11a

.PHONY: client-build assets-pack build e2e-build e2e server-build api-gen api-gen-check go-mod go-lint go-test govulncheck migrations-lint itest tools-ci ci \
	go-licenses no-pulsusdb-host dev-env dev-db dev-migrate dev-up dev-down dev-reset itest-local dev-smoke \
	itest-local-selftest bench-bff cpu-instr cpu-instr-update

# Dev stack (dev/compose.yaml, docs/development/dev-stack.md). COMPOSE may be any Docker Compose v2
# compatible command. DEV_ENV_FILE is untracked: it holds the local settings and the PulsusDB URL.
COMPOSE ?= docker compose
DEV_ENV_FILE ?= dev/local.env
DEV_PROJECT ?= pulsus-dash
DC = $(COMPOSE) -f dev/compose.yaml -p $(DEV_PROJECT)
# Recipes chain their steps with &&, so a failure stops the recipe even without the -e of
# .SHELLFLAGS.
LOAD_ENV = set -a && . $(DEV_ENV_FILE) && set +a
# The pulsus-fake service's loopback port (dev/compose.yaml); dev-migrate seeds it as the
# datasource when dev/local.env sets no PULSUS_DASH_DATASOURCE_URL.
DEV_PULSUS_FAKE_PORT ?= 59091
export DEV_PULSUS_FAKE_PORT
ITEST_PROJECT ?= pulsus-dash-itest
ITEST_PG16_PORT ?= 57432
ITEST_PG15_PORT ?= 57433

# The client build the BFF embeds (VITE_API_MODE=$(API_MODE)).
client-build:
	VITE_API_MODE=$(API_MODE) VITE_GIT_SHA=$(GIT_SHA) npm --prefix client run build

# Packs client/dist into the embedded tree with a signed manifest, under a key generated afresh
# for this build (plan #59 Q3); the private key never leaves build/keys/.
assets-pack:
	node client/scripts/pack-assets.ts --gen-key build/keys
	node client/scripts/pack-assets.ts --in client/dist --out server/internal/gateway/static/dist --key build/keys/asset-signing.key

# The release binary: the client embedded (-tags embedassets) and the build's public key.
build: client-build assets-pack
	CGO_ENABLED=0 go -C server build -tags embedassets -trimpath -buildvcs=true -ldflags "-X github.com/digitalis-io/pulsus-dash/server/internal/core.Version=$(VERSION) -X github.com/digitalis-io/pulsus-dash/server/internal/gateway/static.releasePublicKeys=$$(cat $(CURDIR)/build/keys/asset-signing.pub)" -o $(OUT) ./cmd/pulsus-dash

# The binaries the end-to-end suite serves (client/playwright.config.ts): the stub and http BFFs
# and the PulsusDB fake (tools/e2e/fake.sh).
e2e-build:
	$(MAKE) build API_MODE=stub VERSION=0.1.0-e2e OUT=$(CURDIR)/build/e2e-stub/pulsus-dash
	$(MAKE) build API_MODE=http VERSION=0.1.0-e2e OUT=$(CURDIR)/build/e2e-http/pulsus-dash
	CGO_ENABLED=0 go -C server build -trimpath -o $(CURDIR)/build/e2e-fake/pulsus-fake ./cmd/pulsus-fake

# Needs make e2e-build and E2E_PG_APP_URL / E2E_PG_OWNER_URL (docs/development/build-and-ci.md).
e2e:
	npm --prefix client run e2e

# The server alone, without the client: serve refuses to start unless --api-only.
server-build:
	CGO_ENABLED=0 go -C server build -trimpath -buildvcs=true -ldflags "-X github.com/digitalis-io/pulsus-dash/server/internal/core.Version=$(VERSION)" -o ../build/pulsus-dash ./cmd/pulsus-dash

api-gen:
	go -C server tool oapi-codegen -config oapi-codegen.yaml ../api/openapi.yaml
	go -C server tool sqlc generate
	npm --prefix tools/api-gen run gen

# ci:api-gen: compares regenerated code with the committed files (writes only to a temporary
# directory), then runs the checker's self-test.
api-gen-check:
	server/scripts/api-gen-check.sh
	server/scripts/test-api-gen-check.sh

# ci:go-mod
go-mod:
	go -C server mod verify && go -C server mod tidy -diff

# ci:go-lint, then the depguard self-test: each fixture must fail with its rule's desc.
go-lint:
	@golangci-lint version 2>/dev/null | grep -q '$(GOLANGCI_VERSION)' || { echo "golangci-lint $(GOLANGCI_VERSION) required"; exit 1; }
	cd server && golangci-lint run ./...
	server/scripts/check-depguard-fixture.sh

# ci:go-test
go-test:
	CGO_ENABLED=1 go -C server test -race ./...

# ci:govulncheck
govulncheck:
	go -C server tool govulncheck ./...

# ci:migrations: the migrations pass squawk, and the failing fixture must fail with
# require-concurrent-index-creation.
migrations-lint:
	squawk --config server/.squawk.toml server/migrations/*.sql
	@if out=$$(squawk --config server/.squawk.toml server/testdata/squawk/create_index_not_concurrently.sql 2>&1); then \
	  echo "the squawk fixture passed; it must fail"; exit 1; fi; \
	  if ! grep -q require-concurrent-index-creation <<<"$$out"; then \
	  echo "$$out"; echo "the squawk fixture failed without require-concurrent-index-creation"; exit 1; fi; \
	  echo "squawk fixture fails as expected (require-concurrent-index-creation)"

# itest: needs DASH_ITEST_PG_URLS (PostgreSQL 15 and 16 superuser URLs).
itest:
	@test -n "$${DASH_ITEST_PG_URLS:-}" || { echo "DASH_ITEST_PG_URLS is not set"; exit 1; }
	CGO_ENABLED=1 go -C server test -race -tags itest -count=1 ./...

# The pinned linters, verified by sha256, into build/bin.
tools-ci:
	mkdir -p $(BIN)
	curl -fsSL -o $(BIN)/golangci-lint-$(GOLANGCI_VERSION).tar.gz https://github.com/golangci/golangci-lint/releases/download/v$(GOLANGCI_VERSION)/golangci-lint-$(GOLANGCI_VERSION)-linux-amd64.tar.gz
	echo "$(GOLANGCI_SHA256)  $(BIN)/golangci-lint-$(GOLANGCI_VERSION).tar.gz" | sha256sum -c -
	tar -xzf $(BIN)/golangci-lint-$(GOLANGCI_VERSION).tar.gz -C $(BIN) --strip-components=1 golangci-lint-$(GOLANGCI_VERSION)-linux-amd64/golangci-lint
	curl -fsSL -o $(BIN)/squawk https://github.com/sbdchd/squawk/releases/download/v$(SQUAWK_VERSION)/squawk-linux-x64
	echo "$(SQUAWK_SHA256)  $(BIN)/squawk" | sha256sum -c -
	chmod +x $(BIN)/squawk

# ci:go-licenses: the binary's module licences on the allowlist, build/THIRD_PARTY_NOTICES.txt,
# then the self-test (a GPL-2.0-only fixture must fail).
go-licenses:
	server/scripts/go-licenses.sh
	server/scripts/check-go-licenses-fixture.sh

# ci:no-pulsusdb-host: the checker's self-test, then the scan of every tracked file. A present
# DEV_ENV_FILE adds its PulsusDB host to the forbidden list. ARGS=--show-paths names the files.
no-pulsusdb-host:
	if [ -f $(DEV_ENV_FILE) ]; then $(LOAD_ENV); fi && \
	  python3 -I -m unittest discover -s tools/no-pulsusdb-host -p 'test_*.py' && \
	  python3 -I tools/no-pulsusdb-host/check.py $(ARGS)

dev-env:
	@test -f $(DEV_ENV_FILE) || { echo "$(DEV_ENV_FILE) is missing: create it as described in docs/development/dev-stack.md"; exit 1; }

# Postgres 16 only, with its persistent volume; no settings file needed.
dev-db:
	$(DC) up -d --wait pg16

# The order is in the recipes, not in sibling prerequisites, so it holds under make -j: dev-env
# first (a missing settings file stops before anything starts), then each step in turn.
dev-migrate: dev-env
	$(MAKE) server-build
	$(LOAD_ENV) && PULSUS_DASH_DATASOURCE_URL="$${PULSUS_DASH_DATASOURCE_URL:-http://localhost:$(DEV_PULSUS_FAKE_PORT)}" build/pulsus-dash migrate

# Postgres (healthy), the PulsusDB fake (running, built on first use), migrations, then the server
# in the foreground: Ctrl-C stops it, the containers keep running. server-build has no embedded
# client, so it serves --api-only; the client runs from npm run dev (VITE_API_MODE=http), which
# proxies /api here.
dev-up: dev-env
	$(MAKE) dev-db
	$(DC) up -d --wait pulsus-fake
	$(MAKE) dev-migrate
	$(LOAD_ENV) && exec build/pulsus-dash serve --api-only

# Stops the containers and keeps the pg16-data volume.
dev-down:
	$(DC) down

# Removes the containers and the volume; the next dev-up seeds afresh.
dev-reset:
	$(DC) --profile itest down -v

# itest against the compose stack, in its own project and ports; removed on every exit. A failed
# up --wait stops the recipe: the tests never run against whatever else answers on those ports.
itest-local:
	trap '$(COMPOSE) -f dev/compose.yaml -p $(ITEST_PROJECT) --profile itest down -v' EXIT; \
	  DEV_PG16_PORT=$(ITEST_PG16_PORT) DEV_PG15_PORT=$(ITEST_PG15_PORT) \
	  $(COMPOSE) -f dev/compose.yaml -p $(ITEST_PROJECT) --profile itest up -d --wait pg16 pg15 && \
	  DASH_ITEST_PG_URLS='pg16=postgres://postgres@localhost:$(ITEST_PG16_PORT)/postgres?sslmode=disable,pg15=postgres://postgres@localhost:$(ITEST_PG15_PORT)/postgres?sslmode=disable' \
	  $(MAKE) itest

# ci:dev-stack, no containers needed: a failed up --wait fails itest-local, runs no test and still
# cleans up (stand-ins for compose and make).
itest-local-selftest:
	dev/itest-local-selftest.sh

# ci:dev-stack: the smoke test, then its self-test (nothing left behind after a failure).
dev-smoke:
	dev/smoke.sh
	dev/smoke-selftest.sh

# The BFF budgets (plan #62 §8.1, T05-006). bench-bff runs the two time budgets: under
# REFERENCE_LAB=1 they fail over their thresholds, elsewhere they skip (reference lab only).
bench-bff:
	go -C server test -count=1 -run '^TestBudget' -v ./internal/gateway

# bench:cpu-instr: instruction counts of the BFF workloads under cachegrind; more than +3 % over
# the committed baseline fails (needs valgrind). cpu-instr-update rewrites the baseline: it is run
# in CI and the result is committed with the change that moves it.
cpu-instr:
	server/scripts/cpu-instr.sh

cpu-instr-update:
	server/scripts/cpu-instr.sh --update

ci: go-mod api-gen-check go-lint go-test govulncheck migrations-lint build go-licenses no-pulsusdb-host \
	itest-local-selftest
