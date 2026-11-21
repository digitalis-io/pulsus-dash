# ADR-0021: Query planning is server-side

| | |
|---|---|
| **Status** | Accepted (2026-11-21, product owner) |
| **Amends** | [ADR-0015](0015-go-bff.md) "Query validation" (the BFF now parses PromQL, for planning only); [T07](../technical/T07-scene-query-planner.md) §0 and T07-002 (the v1 "no parse, no rewrite" rule); [T09](../technical/T09-query-editors.md) §0, T09-010 and T09-015; [T06](../technical/T06-bff-architecture.md) §4.3. [ADR-0018](0018-query-language-modules.md) is unchanged: planning is added to its language modules |
| **Source** | Owner decision of 2026-11-21, with two sub-decisions: the upstream Go PromQL parser (Apache-2.0) reads the planning shape, and a raw query of 64 to 128 KiB may reach the request URL before the server refuses it |
| **See** | [ADR-0008](0008-dash-alert-evaluator.md), [ADR-0014](0014-typescript-react-web-client.md), [ADR-0018](0018-query-language-modules.md); T06-005, T06-028; T07-002, T07-003, T07-014; T09-002, T09-009, T09-010, T09-015; [T16](../technical/T16-alert-evaluator.md) |

## Context

The first PromQL slice (#63 Part A) plans queries in the browser: `client/src/explore/plan.ts`
rewrites a bare counter to `rate(…[w])` and a bare histogram bucket to `sum by (le) (rate(…[w]))`,
picks the window `max(4 × step, step + S, 4 × S)`, and checks the 64 KiB sent limit. #64 Part A
plans to add variable and macro substitution (`$x`, `${x}`, `$__interval`, `$__rate_interval`) in
the client as well. The BFF only computes the step grid from the panel width (`PromGrid`, #62) and
forwards the text it receives.

Two problems follow:

1. **Two evaluators, two plans.** The alert evaluator (ADR-0008, T16) runs in Go. A rule made from
   a panel must run the query the panel shows. With planning in TypeScript, the evaluator would need
   a second implementation, which drifts.
2. **Security.** With planning in the browser, the browser decides the final text that PulsusDB
   runs. A modified client can send anything the route accepts. Data scopes (T07-014, T10) must be
   applied to the text that is really sent, and the server can only be sure of that text if it
   built it.

## Decision

1. **Planning lives in the Go PulsusDB client's language modules.** "Planning" is everything
   between the user's text and the request to PulsusDB:
   - variable and macro substitution (`$name`, `${name}`, `$__interval`, `$__rate_interval`);
   - the step from the chart width (already `PromGrid`, T07-003);
   - the counter → `rate` and histogram → `sum by (le) (rate(…))` rewrites behind the rate toggle;
   - the rate window `max(4 × step, step + S, 4 × S)`, with `S` = 15 s until a per-binding scrape
     interval exists;
   - the query-size limits: 131 072 bytes of raw text, 65 536 bytes of planned text.

   PromQL planning is `internal/pulsusdb/prom` (`prom.Plan`), and LogQL planning is
   `internal/pulsusdb/logs`. Each module owns its planner and its fixtures (ADR-0018 §1, §3). The
   planner is pure: it takes the inputs and the metric types and returns the planned query. It does
   no I/O. The query routes and the alert evaluator call the same function, and so do the scene
   planner (T07 Bind and Lower) and later callers such as AI RCA. Board variables and the panel's
   step therefore give byte-identical text everywhere.

   For alerting, a rule created from a panel stores the panel's raw query, its inputs and the
   panel's planning step (`plan_step_ms`). The evaluator plans with that stored step, not with the
   rule's evaluation interval: the step sets the rate window and the macros, and the evaluation
   interval only sets how often the rule runs. A rule written by hand, with no stored step, plans
   with its evaluation interval as the step (T16 §4.2).
2. **The browser sends inputs, not a plan.** A query request carries:
   - the raw query text;
   - the variable values;
   - the panel width (range) or an optional step (instant);
   - the time window;
   - the rate toggle.

   The server resolves the metric types itself, from PulsusDB metadata cached per tenant binding (one
   entry, with its own singleflight, per binding).
3. **The server returns what it planned,** on success and on every error raised after planning.
   This carries:
   - the planned text, for "Sent query";
   - the substituted text before the rate rewrite, for "Open in Explore";
   - the facts the client shows (rate candidate and applied, histogram, value type, step, window,
     bytes).

   The server maps PulsusDB's error position back into the raw text:
   - inside an inserted variable value, it maps to the reference's start;
   - inside a rewrite prefix or suffix, there is no position.

   The client therefore underlines without a map of its own (T09-009).
4. **The browser keeps what is presentation.** The client keeps:
   - the editor, highlighting and completion;
   - the Lezer `shape`, used to choose between the range and instant routes and for the pre-run
     vis hint;
   - the visualisation choice, driven by the returned facts;
   - a size pre-check (131 072 bytes) and a check for unset variables.

   Both checks are hints only, so the UI can refuse early. The server repeats them and is
   authoritative. No client code decides the text sent to PulsusDB. A TS mirror of the planner may
   exist only in `StubApi` (dev and stub builds), held to the same fixtures.
5. **PromQL is parsed on the server, for planning only.** `prom` reads the query's shape with the
   upstream Go PromQL parser (Apache-2.0). The shape is:
   - the top-level bare selector and its byte span;
   - the selector metric names;
   - whether there is a `histogram_quantile`;
   - the value type.

   The rewrite wraps the exact source bytes and never re-prints user text. A text the parser rejects
   gets the unknown shape and is sent with substitution only. PulsusDB stays the only authority on
   validity (T09-002), and the Go parser never refuses a query. LogQL planning needs no parse: it
   does substitution, size limits and the fixed volume template that #65 already has.
6. **Golden parity.** `wire/fixtures/plan/promql.json`, and later `logql.json`, hold the cases as
   inputs (text, variables, step, rate toggle, metric types) and outputs (planned text, substituted
   text, facts, and position mappings). Every existing `plan.ts` and `substitute` test becomes a
   case. The cases include a panel-to-rule case: panel step 15 s, rule interval 60 s, and the
   evaluator's planned text is byte-identical to the panel's. The Go planner (`unit:plan-parity`)
   and the TS stub mirror both run the file. The Go shape
   and the Lezer `shape` are also checked case by case, on the `shape` member.
7. **Security: the server is the authority on the final query.** The order is fixed:
   1. validate the inputs and their sizes;
   2. substitute;
   3. plan;
   4. guard reserved names (T07-020);
   5. scope rewrite (T07-014; full tenant in v1);
   6. send.

   The scope applies to the final text, so no variable value or raw text can get past it. The
   client cannot send a query that the server did not build from the client's inputs.

## Consequences

- One planner per language serves Explore, boards, alerts, backtests and AI. A panel's "Sent
  query", the alert preview and the evaluator show the same text.
- The route contracts change. `query` becomes raw text of up to 131 072 bytes, and the requests
  gain `vars`, `rate` and (instant) `step_ms`. Responses and error bodies gain `planned`. The
  planned 64 KiB check moves to the server (413).
- The client loses `planRun`, `rateWindowMs` and the sent-size check from its run path, along with
  #64's planned `substitute`. Explore's "Run waits for metric types" gate goes, because the server
  resolves the types.
- The server gains a Go module dependency (the PromQL parser package), under `ci:go-mod`,
  `govulncheck` and the licence gate. `depguard` allows it in `internal/pulsusdb/prom` only.
- The raw-text limit (131 072 bytes) is above the planned-text limit (65 536 bytes), so a raw query
  of 64 to 128 KiB can reach the request URL before the server plans it and refuses it (413). The
  owner accepted this on 2026-11-21: only the server can measure the planned text.
- PromQL shape parity between Lezer and the Go parser becomes a tested contract. A divergence is
  caught by fixtures; it never changes the text the server sends.
- T07's "v1: queries are opaque" now applies only to fusion, normalisation and virtual sources.
  The planner's text rewrites are a closed list (the decision above). Each is a byte-exact wrap or
  substitution with a recorded map.
- A metadata failure degrades the plan: with no types, only the `_total` counter rule applies, and
  a completeness warning says so. The query still runs.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep planning in the browser; the evaluator gets its own Go planner | Two implementations drift; the browser still decides the sent text, so a modified client bypasses the plan and the scope proof covers text the server did not build |
| A Rust planner compiled to WASM for the browser and linked into Go | The server is Go (ADR-0015); cgo or a WASM runtime in the BFF for a few hundred lines of planning costs more than it saves |
| A shared TS planner run on the server (embedded JS runtime) | A second runtime in the BFF, with no gain over one Go implementation plus fixtures |
| An in-house Go shape reader instead of the upstream parser | It would need its own grammar to get the value type and the top-level selector right. The upstream parser is maintained, permissively licensed, and already named for scope rewriting (ADR-0015 consequences) |
| A single planned route that picks range or instant itself | The client already knows the vis kind from its shape, and the evaluator always runs instant queries. Two routes keep the response schemas strict. Revisit with the scene session (T07 §4.1) |
