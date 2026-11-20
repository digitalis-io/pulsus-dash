# Pulsus Dash server targets (T05 §7.1 gates). Run from the repository root.
SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

VERSION ?= 0.1.0-dev
BIN := $(CURDIR)/build/bin
export PATH := $(BIN):$(PATH)

GOLANGCI_VERSION := 2.15.0
GOLANGCI_SHA256 := 9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea
SQUAWK_VERSION := 2.72.0
SQUAWK_SHA256 := a61661808119a82515565503111099b070c869f73698f61cb1785de5d0c8b11a

.PHONY: server-build api-gen api-gen-check go-mod go-lint go-test govulncheck migrations-lint itest tools-ci ci \
	go-licenses no-pulsusdb-host dev-env dev-db dev-migrate dev-up dev-down dev-reset itest-local dev-smoke

# Dev stack (dev/compose.yaml, docs/development/dev-stack.md). COMPOSE may be any Docker Compose v2
# compatible command. DEV_ENV_FILE is untracked: it holds the local settings and the PulsusDB URL.
COMPOSE ?= docker compose
DEV_ENV_FILE ?= dev/local.env
DEV_PROJECT ?= pulsus-dash
DC = $(COMPOSE) -f dev/compose.yaml -p $(DEV_PROJECT)
# Recipes chain their steps with &&, so a failure stops the recipe even without the -e of
# .SHELLFLAGS.
LOAD_ENV = set -a && . $(DEV_ENV_FILE) && set +a
ITEST_PROJECT ?= pulsus-dash-itest
ITEST_PG16_PORT ?= 57432
ITEST_PG15_PORT ?= 57433

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
	$(LOAD_ENV) && build/pulsus-dash migrate

# Postgres (healthy), migrations, then the server in the foreground: Ctrl-C stops it, Postgres
# keeps running.
dev-up: dev-env
	$(MAKE) dev-db
	$(MAKE) dev-migrate
	$(LOAD_ENV) && exec build/pulsus-dash serve

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

# ci:dev-stack: the smoke test, then its self-test (nothing left behind after a failure).
dev-smoke:
	dev/smoke.sh
	dev/smoke-selftest.sh

ci: go-mod api-gen-check go-lint go-test govulncheck migrations-lint go-licenses no-pulsusdb-host
