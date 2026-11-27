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

.PHONY: client-build client-check assets-pack build e2e-build e2e server-build api-gen api-gen-check go-mod go-lint go-test govulncheck migrations-lint itest tools-ci ci engine-image engine-test engine-lint \
	engine-goldens engine-goldens-update engine-web-image engine-wasm engine-wasm-check engine-e2e \
	engine-wasm-probe e2e-build-probe e2e-build-release client-dev \
	engine-gpu-smoke engine-bench \
	go-licenses no-pulsusdb-host geo-test geo-data geo-check dev-env dev-db dev-migrate dev-up dev-down dev-reset itest-local itest-old-binary dev-smoke \
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
# The goal itest-local runs against its stack: itest, or itest-old-binary.
ITEST_GOAL ?= itest

# The client build the BFF embeds (VITE_API_MODE=$(API_MODE)), with the engine (plan #68 C1), into
# client/$(CLIENT_OUT) (the probe build writes client/dist-probe, plan #68 C2a1).
CLIENT_OUT ?= dist
client-build: engine-wasm
	VITE_API_MODE=$(API_MODE) VITE_GIT_SHA=$(GIT_SHA) npm --prefix client run build -- --outDir $(CLIENT_OUT) --emptyOutDir

# The client `check` job of T05 §7.1, run locally (#263): every client change runs it before push
# (docs/development/build-and-ci.md). `npm run audit` needs the network.
client-check: engine-wasm
	cd client && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && \
	  npm run check:lockfile && npm run lint && npm run typecheck && \
	  npm run tokens -- --check && npm run token-lint && npm test && \
	  $(MAKE) -C .. geo-test && npm run geo-data && \
	  npm run build && npm run size && \
	  VITE_API_MODE=http npx --no-install vite build --outDir dist-http --emptyOutDir && \
	  ! grep -q '"src/dev/' dist-http/.vite/manifest.json && \
	  npm run size -- dist-http && npm run origins && npm run audit

# Packs client/dist into the embedded tree with a signed manifest, under a key generated afresh
# for this build (plan #59 Q3); the private key never leaves build/keys/.
assets-pack:
	node client/scripts/pack-assets.ts --gen-key build/keys
	node client/scripts/pack-assets.ts --in client/$(CLIENT_OUT) --out server/internal/gateway/static/dist --key build/keys/asset-signing.key

# The release binary: the client embedded (-tags embedassets) and the build's public key.
build: client-build assets-pack
	CGO_ENABLED=0 go -C server build -tags embedassets -trimpath -buildvcs=true -ldflags "-X github.com/digitalis-io/pulsus-dash/server/internal/core.Version=$(VERSION) -X github.com/digitalis-io/pulsus-dash/server/internal/gateway/static.releasePublicKeys=$$(cat $(CURDIR)/build/keys/asset-signing.pub)" -o $(OUT) ./cmd/pulsus-dash

# The binaries the end-to-end suite serves (client/playwright.config.ts): the stub and http BFFs
# and the PulsusDB fake (tools/e2e/fake.sh). The suite runs on host browsers with uncontrolled
# GPUs, so its builds pin Canvas 2D (E2E_ENGINE=canvas2d, plan #256 §3.4): a renderer override in
# a build that still holds the engine. The engine suite proves the default (e2e-build-release).
E2E_ENGINE ?= canvas2d
e2e-build:
	VITE_ENGINE=$(E2E_ENGINE) $(MAKE) build API_MODE=stub VERSION=0.1.0-e2e OUT=$(CURDIR)/build/e2e-stub/pulsus-dash
	VITE_ENGINE=$(E2E_ENGINE) $(MAKE) build API_MODE=http VERSION=0.1.0-e2e OUT=$(CURDIR)/build/e2e-http/pulsus-dash
	CGO_ENABLED=0 go -C server build -trimpath -o $(CURDIR)/build/e2e-fake/pulsus-fake ./cmd/pulsus-fake

# The probe build of e2e:shim-fuzz (plan #68 C2a1 §3.5): the fault build with the probe engine
# (VITE_ENGINE_PROBE=1: client/src/engine/wasm/gen-probe/) in client/dist-probe, served by its own
# stub BFF (tools/e2e/serve.sh probe PORT). Its tree must hold every fault site and the probe
# export; no other build may (ci:probe-absent).
e2e-build-probe: engine-wasm-probe
	VITE_ENGINE_FAULTS=1 VITE_ENGINE_PROBE=1 $(MAKE) build API_MODE=stub VERSION=0.1.0-e2e CLIENT_OUT=dist-probe OUT=$(CURDIR)/build/e2e-probe/pulsus-dash
	node client/scripts/probe-absent.ts --expect-faults --expect-probe client/dist-probe

# The unflagged, fault-free release build the engine suite's default legs use (served on 4176,
# plan #256 §3.4): no VITE_ENGINE, so the engine is the default (ADR-0031).
e2e-build-release:
	$(MAKE) build API_MODE=stub VERSION=0.1.0-e2e CLIENT_OUT=dist-release OUT=$(CURDIR)/build/e2e-release/pulsus-dash
	node client/scripts/probe-absent.ts client/dist-release

# The Vite dev server with the engine built first (plan #256 §3.4): `npm run dev` refuses to start
# without it.
client-dev: engine-wasm
	npm --prefix client run dev

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

# The old-binary gate: itest:board-spec-old-binary and itest:board-tags-old-binary, the previous
# release (the merge-base of HEAD with OLD_BINARY_REF) beside this one on one database (plans #215,
# #198). Needs DASH_ITEST_PG_URLS; a required local gate for every change to the board schema or
# spec. Plain make itest skips the tests.
OLD_BINARY_REF ?= origin/main
itest-old-binary:
	@test -n "$${DASH_ITEST_PG_URLS:-}" || { echo "DASH_ITEST_PG_URLS is not set"; exit 1; }
	server/scripts/itest-old-binary.sh --self-test
	OLD_BINARY_REF=$(OLD_BINARY_REF) server/scripts/itest-old-binary.sh

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
# DEV_ENV_FILE adds its PulsusDB host (and any DASH_FORBIDDEN_HOSTS) to the forbidden list; CI has
# neither. ARGS=--show-paths names the files.
no-pulsusdb-host:
	if [ -f $(DEV_ENV_FILE) ]; then $(LOAD_ENV); fi && \
	  python3 -I -m unittest discover -s tools/no-pulsusdb-host -p 'test_*.py' && \
	  python3 -I tools/no-pulsusdb-host/check.py $(ARGS)

# unit:geo-build and unit:geo-gazetteer-build (T24 §10.3): the geo build tool's tests.
geo-test:
	python3 -I -m unittest discover -s tools/geo -p 'test_*.py'

# ci:geo-data (T24-087): the committed geo assets against tools/geo/manifest.json, decoded.
geo-data:
	npm --prefix client run geo-data

# Rebuilds the geo assets in memory from the pinned sources in GEO_SRC (never committed or
# downloaded; docs/client/supply-chain.md) and compares them byte for byte with the committed files.
# Local only; a PR that changes an asset attaches its output.
geo-check:
	@test -n "$(GEO_SRC)" || { echo "GEO_SRC is not set: the directory of the pinned geo sources"; exit 1; }
	python3 -I tools/geo/build.py "$(GEO_SRC)" --check

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

# itest (or ITEST_GOAL, e.g. itest-old-binary) against the compose stack, in its own project and
# ports; removed on every exit. A failed up --wait stops the recipe: the tests never run against
# whatever else answers on those ports.
itest-local:
	trap '$(COMPOSE) -f dev/compose.yaml -p $(ITEST_PROJECT) --profile itest down -v' EXIT; \
	  DEV_PG16_PORT=$(ITEST_PG16_PORT) DEV_PG15_PORT=$(ITEST_PG15_PORT) \
	  $(COMPOSE) -f dev/compose.yaml -p $(ITEST_PROJECT) --profile itest up -d --wait pg16 pg15 && \
	  DASH_ITEST_PG_URLS='pg16=postgres://postgres@localhost:$(ITEST_PG16_PORT)/postgres?sslmode=disable,pg15=postgres://postgres@localhost:$(ITEST_PG15_PORT)/postgres?sslmode=disable' \
	  $(MAKE) $(ITEST_GOAL)

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
	itest-local-selftest geo-test geo-data

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

# The engine in the browser (plan #68 C1 §5.1): the web image adds the pinned nightly, wasm-bindgen,
# binaryen, Node, Go and Playwright's Chromium to the lavapipe image. Inside it ENGINE_IN_IMAGE=1,
# so these targets run directly; outside, each runs itself in the image (host network, the
# repository at /w, git's common directory mounted where a worktree's .git file points).
ENGINE_WEB_IMAGE ?= pulsus-engine-web:local
GIT_COMMON := $(abspath $(shell git rev-parse --git-common-dir 2>/dev/null))
ENGINE_WEB_RUN = $(DOCKER) run --rm $(ENGINE_RUN_FLAGS) --network host -v $(CURDIR):/w \
	$(if $(filter $(CURDIR)/%,$(GIT_COMMON)),,-v $(GIT_COMMON):$(GIT_COMMON):ro) \
	-e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
	-e CARGO_TARGET_DIR=/w/engine/target/image -e E2E_PG_APP_URL -e E2E_PG_OWNER_URL \
	-w /w $(ENGINE_WEB_IMAGE)
ENGINE_E2E_PROJECT ?= pulsus-engine-e2e
ENGINE_E2E_PG_PORT ?= 57532

engine-web-image:
	$(DOCKER) build -f engine/ci/web.Dockerfile --build-arg BASE=$(ENGINE_IMAGE) -t $(ENGINE_WEB_IMAGE) engine/ci

# client/src/engine/wasm/gen/ (git-ignored): `cargo xtask build-wasm`. `make build` needs it.
engine-wasm:
ifeq ($(ENGINE_IN_IMAGE),1)
	cd engine && cargo xtask build-wasm
else
	$(ENGINE_WEB_RUN) make engine-wasm
endif

# client/src/engine/wasm/gen-probe/ (git-ignored): the engine with the `probe` feature, for the probe
# build only (`cargo xtask build-wasm --probe`).
engine-wasm-probe:
ifeq ($(ENGINE_IN_IMAGE),1)
	cd engine && cargo xtask build-wasm --probe
else
	$(ENGINE_WEB_RUN) make engine-wasm-probe
endif

# ci:engine-gen: two builds from separate target directories are byte-equal, and their .d.ts and
# the generated layout equal the committed files.
ENGINE_GEN_FILES := dash_core_mt.js dash_core_mt.d.ts dash_core_mt_bg.wasm dash_core_mt_bg.wasm.d.ts
engine-wasm-check:
ifeq ($(ENGINE_IN_IMAGE),1)
	cd engine && \
	  CARGO_TARGET_DIR=$${CARGO_TARGET_DIR:-target}/gen-a cargo xtask build-wasm --out target/engine-gen/a && \
	  CARGO_TARGET_DIR=$${CARGO_TARGET_DIR:-target}/gen-b cargo xtask build-wasm --out target/engine-gen/b && \
	  for f in $(ENGINE_GEN_FILES); do \
	    cmp target/engine-gen/a/$$f target/engine-gen/b/$$f || { echo "ci:engine-gen: $$f differs between builds"; exit 1; }; done && \
	  { cmp target/engine-gen/a/dash_core_mt.d.ts ../client/src/engine/wasm/dash_core_mt.d.ts || \
	    { echo "ci:engine-gen: client/src/engine/wasm/dash_core_mt.d.ts is stale"; exit 1; }; } && \
	  cargo xtask gen-layout --check && echo "ci:engine-gen: ok"
else
	$(ENGINE_WEB_RUN) make engine-wasm-check
endif

# Prints the adapter each engine e2e project sees and whether it renders (record it in the PR).
engine-gpu-smoke:
ifeq ($(ENGINE_IN_IMAGE),1)
	cd client && node scripts/engine-gpu-smoke.ts
else
	$(ENGINE_WEB_RUN) make engine-gpu-smoke
endif

# The frame benches (plan #68 C2d1; T05 §4.3 bench:frame-gallery, bench:frame-line-1e8), report
# only: the PulsusDB fake and the probe build (e2e-build-probe, its stub BFF on 4175), then
# project `bench` of playwright.engine.config.ts (ENGINE_BENCH=1: lavapipe, one worker). The
# results are client/test-results/bench/*.json: Playwright clears client/test-results/ when the run
# starts and keeps it after. A PostgreSQL 16 as for engine-e2e. Never part of engine-e2e.
ENGINE_BENCH_PROJECT ?= pulsus-engine-bench
ENGINE_BENCH_PG_PORT ?= 57534
engine-bench:
ifeq ($(ENGINE_IN_IMAGE),1)
	cd client && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && \
	  CGO_ENABLED=0 go -C ../server build -trimpath -o $(CURDIR)/build/e2e-fake/pulsus-fake ./cmd/pulsus-fake && \
	  $(MAKE) -C .. e2e-build-probe && \
	  ENGINE_BENCH=1 npx playwright test -c playwright.engine.config.ts --project bench
else
	@if [ -n "$${E2E_PG_APP_URL:-}" ]; then $(ENGINE_WEB_RUN) make engine-bench; else \
	  trap '$(COMPOSE) -f dev/compose.yaml -p $(ENGINE_BENCH_PROJECT) down -v' EXIT; \
	  DEV_PG16_PORT=$(ENGINE_BENCH_PG_PORT) $(COMPOSE) -f dev/compose.yaml -p $(ENGINE_BENCH_PROJECT) up -d --wait pg16 && \
	  E2E_PG_APP_URL='postgres://pulsus_app@localhost:$(ENGINE_BENCH_PG_PORT)/pulsus_dash?sslmode=disable' \
	  E2E_PG_OWNER_URL='postgres://pulsus_owner@localhost:$(ENGINE_BENCH_PG_PORT)/pulsus_dash?sslmode=disable' \
	  $(ENGINE_WEB_RUN) make engine-bench; fi
endif

# The engine e2e suite (playwright.engine.config.ts): a PostgreSQL 16 for the e2e BFFs (the
# compose service, in its own project, taken down with its volume on exit; E2E_PG_APP_URL and
# E2E_PG_OWNER_URL set by the caller skip it), then in the image: the fault build served by the
# e2e BFFs (its tree must hold every fault site), the clean stub and http builds (engine row, no
# test hook), the probe build (e2e-build-probe, for e2e:shim-fuzz only), the unflagged release
# build (e2e-build-release, the default legs of e2e:mode-matrix, plan #256), and the specs with
# dash-golden. The WebGPU leg's report-only reason heads the run.
engine-e2e:
ifeq ($(ENGINE_IN_IMAGE),1)
	cd client && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && \
	  VITE_ENGINE_FAULTS=1 $(MAKE) -C .. e2e-build && \
	  node scripts/probe-absent.ts --expect-faults dist && \
	  VITE_API_MODE=stub npx vite build --outDir dist-release-stub --emptyOutDir && \
	  VITE_API_MODE=http npx vite build --outDir dist-release-http --emptyOutDir && \
	  npm run size -- dist-release-stub && npm run size -- dist-release-http && \
	  node scripts/check-bundle-modules.ts dist-release-stub dist-release-http && \
	  node scripts/probe-absent.ts dist-release-stub && node scripts/probe-absent.ts dist-release-http && \
	  $(MAKE) -C .. e2e-build-probe && \
	  $(MAKE) -C .. e2e-build-release && \
	  (cd ../engine && cargo build -p dash-golden --release --locked) && \
	  DASH_GOLDEN_BIN=$${CARGO_TARGET_DIR:-../engine/target}/release/dash-golden \
	    npx playwright test -c playwright.engine.config.ts
else
	@if [ -n "$${E2E_PG_APP_URL:-}" ]; then $(ENGINE_WEB_RUN) make engine-e2e; else \
	  trap '$(COMPOSE) -f dev/compose.yaml -p $(ENGINE_E2E_PROJECT) down -v' EXIT; \
	  DEV_PG16_PORT=$(ENGINE_E2E_PG_PORT) $(COMPOSE) -f dev/compose.yaml -p $(ENGINE_E2E_PROJECT) up -d --wait pg16 && \
	  E2E_PG_APP_URL='postgres://pulsus_app@localhost:$(ENGINE_E2E_PG_PORT)/pulsus_dash?sslmode=disable' \
	  E2E_PG_OWNER_URL='postgres://pulsus_owner@localhost:$(ENGINE_E2E_PG_PORT)/pulsus_dash?sslmode=disable' \
	  $(ENGINE_WEB_RUN) make engine-e2e; fi
endif
