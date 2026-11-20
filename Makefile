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

.PHONY: server-build api-gen api-gen-check go-mod go-lint go-test govulncheck migrations-lint itest tools-ci ci

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

# ci:go-lint
go-lint:
	@golangci-lint version 2>/dev/null | grep -q '$(GOLANGCI_VERSION)' || { echo "golangci-lint $(GOLANGCI_VERSION) required"; exit 1; }
	cd server && golangci-lint run ./...

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

# Parts B and C of #59 append targets.
ci: go-mod api-gen-check go-lint go-test govulncheck migrations-lint
