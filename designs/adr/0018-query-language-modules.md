# ADR-0018: One PulsusDB client with a module per query language

| | |
|---|---|
| **Status** | Accepted (2026-11-21, product owner) |
| **Amends** | [T06](../technical/T06-bff-architecture.md) §4.3 (client layout) and [T09](../technical/T09-query-editors.md) §5.1 (`QueryLanguage`). [ADR-0015](0015-go-bff.md) is unchanged: `internal/pulsusdb` stays the only package that builds requests to PulsusDB |
| **Source** | Owner decision of 2026-11-21 |
| **See** | [ADR-0005](0005-arrow-wire-format.md), [ADR-0014](0014-typescript-react-web-client.md), [ADR-0015](0015-go-bff.md); T06-005, T06-006, T06-009, T06-010, T06-011; T09-001, T09-003, T09-007, T09-014; [R1](../technical/pulsusdb-requirements.md) |

## Context

Dash queries four languages (PromQL, LogQL, TraceQL, profile selectors) on one backend, PulsusDB.
The first client code puts every route in one flat package, and the editor contract (T09 §5.1) has
no slot for highlighting or completion. As LogQL, TraceQL and profiles arrive, each language would
otherwise add its own transport, tenant handling and decoders on the server, and its own editor
wiring in Explore and on board panels. Each language also has to send requests in the shapes PulsusDB
is tested against (parameter names, defaults, step and limit handling), and those shapes differ by
language.

## Decision

1. **Server: one client, one shared core, one module per language.** `internal/pulsusdb` is the
   core. It owns:
   - transport and request decoration (T06-005);
   - the tenant header and tenant slots (T06-006);
   - retries and deadlines (T06-009, T06-010);
   - limits;
   - redaction;
   - the decoder seam: JSON now, Arrow when R1 is negotiated per cluster (`r1_arrow_accept`, T06-011,
     ADR-0005).

   `internal/pulsusdb/{prom,logs,traces,profiles}` are the language modules. Each owns its routes,
   its request shaping, its decoders and its fixtures (`testdata/`). A module describes a call and
   hands it to the core; it never opens a connection itself.
2. **Request shapes.** Each module sends the request shapes of the reference clients PulsusDB is
   tested with, for its language. Fixtures record those shapes, and module tests assert them.
3. **Isolation.** No language module imports another, and the core imports no module. Modules share
   only the core. `depguard` enforces both rules. Code that two modules need moves into the core
   only if it is language-neutral; otherwise it is duplicated. Any module can then be split out if a
   second backend is ever added.
4. **Callers.** Gateway handlers and cross-signal features (Correlate, Entity Lens, AI RCA) import
   the modules they need and go through the same core. There is one request path for every signal.
5. **Browser: one `QueryLanguage` per language.** Each language implements the `QueryLanguage`
   interface in `client/src/editor/lang/types.ts` (#63 Part A). The interface covers:
   - highlighting;
   - completion;
   - upstream lookups (through the BFF, scope-keyed, T09-014);
   - the shape and diagnostics members that Part A already has.

   Implementations live in `client/src/editor/lang/<lang>/`, and no language directory imports
   another. A static table maps each language id to a lazy import. Explore, the panel editor and
   board panels use only the interface and stay language-generic.

## Consequences

- Adding a language means adding one server module and one `lang/<id>/` directory. No new transport,
  tenant, retry or decoder code is written, and Explore and panel code is untouched.
- Tenant decoration, deadlines, retry budgets and redaction are tested once, in the core. Each module
  tests only its shapes and decoders against its fixtures.
- When R1 ships, it changes only the core's decoder seam and each module's Arrow decoder. Routes and
  request shaping stay as they are.
- The existing flat files (`promql.go`, `logql.go`, `logpage.go`, `grid.go`, …) move into `prom/` and
  `logs/` in a refactor with no behaviour change, guarded by the existing tests and fixtures. Until
  that refactor is done, new language code goes straight into its module.
- A language-specific UI (for example the metric browser) imports its module's typed lookups
  directly. That is allowed. Only the generic surfaces are restricted to the interface.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A per-language plugin system: a runtime registry, versioned plugin APIs, and independently loaded language plugins | There is one backend, so there is nothing to plug in. Cross-signal features (Correlate, Entity Lens, AI RCA) need one request path with one tenant, deadline and retry policy, and plugins would split it. The registry, the versioning and the compatibility tests would cost more than they return for four built-in languages |
| Keep one flat package and one editor wiring per language | Transport and tenant code is copied per language, and the generic surfaces grow a branch for every language |
| A separate client per language, each with its own transport | Several retry budgets and tenant paths, which breaks T06-005 (one client) and T06-009 (one budget per cluster) |
