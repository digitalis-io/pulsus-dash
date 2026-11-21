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

.PHONY: client-build assets-pack build e2e-build e2e server-build api-gen api-gen-check go-mod go-lint go-test govulncheck migrations-lint itest tools-ci ci engine-image engine-test engine-lint engine-goldens engine-goldens-update

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

# The two binaries the end-to-end suite serves (client/playwright.config.ts).
e2e-build:
	$(MAKE) build API_MODE=stub VERSION=0.1.0-e2e OUT=$(CURDIR)/build/e2e-stub/pulsus-dash
	$(MAKE) build API_MODE=http VERSION=0.1.0-e2e OUT=$(CURDIR)/build/e2e-http/pulsus-dash

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
ci: go-mod api-gen-check go-lint go-test govulncheck migrations-lint build

# Engine (plan #68 Part A): every target runs in the pinned lavapipe image (engine/ci, T05-004), as
# engine.yml does. DOCKER may be podman; rootless Podman keeps file ownership with
# ENGINE_RUN_FLAGS=--userns=keep-id. The image's own target dir keeps its build apart from a host one.
DOCKER ?= docker
ENGINE_IMAGE ?= pulsus-engine-ci:local
ENGINE_RUN_FLAGS ?=
ENGINE_RUN = $(DOCKER) run --rm $(ENGINE_RUN_FLAGS) -v $(CURDIR):/w -w /w/engine -e CARGO_TARGET_DIR=/w/engine/target/image -e GOLDEN_UPDATE $(ENGINE_IMAGE)

engine-image:
	$(DOCKER) build -f engine/ci/lavapipe.Dockerfile -t $(ENGINE_IMAGE) engine/ci

# unit:* (parity, property and GPU tests).
engine-test:
	$(ENGINE_RUN) cargo nextest run --workspace --exclude dash-golden --locked

# ci:engine-lint, ci:spec-lint, ci:dep-audit (engine leg).
engine-lint:
	$(ENGINE_RUN) bash -euo pipefail -c 'cargo fmt --all --check && cargo clippy --workspace --all-targets --locked -- -D warnings && cargo xtask spec-lint && cargo deny --locked check licenses advisories bans sources'

# golden:gallery, golden:decimation-ref, golden:decimation-raw, golden:extreme-range.
engine-goldens:
	$(ENGINE_RUN) cargo test -p dash-golden --release --locked golden_

# Writes engine/crates/dash-golden/goldens/*.png; CI's `golden-update` label is the reviewed path.
engine-goldens-update:
	GOLDEN_UPDATE=1 $(MAKE) engine-goldens
