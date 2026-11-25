# ADR-0024: Markdown runtime dependencies (`commonmark`, `parse5`, `parse5-sax-parser`); amends 0014 §7

| | |
|---|---|
| **Status** | Accepted (2026-11-25, on merge of #153, under the owner's standing authorisation for pipeline design changes) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §7, the runtime dependency allowlist: three packages and their closure. The rest of ADR-0014 is unchanged |
| **Source** | Issue #153 part A (the Text / Markdown widget and the one Markdown renderer, VIZ-054, VIZ-056) |
| **See** | [T24](../technical/T24-geo-schematic-and-widget-panels.md) §5.2, §5.4, T24-004, T24-006; [T18](../technical/T18-security.md) T18-005, T18-013; [T08](../technical/T08-dom-component-kit.md) T08-011 |

## Context

ADR-0014 §7 allowlists runtime dependencies in `client/dependency-policy.json`; adding one is a
reviewed change. T18-013 needs a CommonMark parser that yields a syntax tree, rendered by our own
renderer into React elements. The import of iframe panels (VIZ-056) needs the spec HTML tree and
tokenizer, to find iframe destinations in raw HTML, without a Trusted Types sink (T18-005).

## Decision

1. **Allowlist** `commonmark` 0.31.2 (BSD-2-Clause; closure `entities` 3.0.1 BSD-2-Clause, `mdurl`
   1.0.1 MIT, `minimist` 1.2.8 MIT), `parse5` 8.1.1 (MIT; closure `entities` 9.0.0 BSD-2-Clause) and
   `parse5-sax-parser` 8.0.1 (MIT).
2. **Used together as a union.** `findIframes` takes the union of the `parse5` tree and the
   `parse5-sax-parser` tokens (T24 §5.2): each covers a context the other misses.
3. **Policy entries.** `runtimeAllowlist` gains `commonmark`, `parse5` and `parse5-sax-parser`;
   `runtimeClosure.markdown` is those plus `entities`, `mdurl` and `minimist`. `parse5` moves from
   devDependencies to dependencies; `@types/commonmark` is a dev dependency. The implementation
   issue (T24 A1) makes these changes.
4. Two `entities` versions ship until `commonmark` updates. `minimist` is CLI-only and is never
   imported.

## Consequences

- The Markdown and parse5 code loads as lazy chunks within the ADR-0014 §8 budgets.
- The audit and licence gates apply to the new packages: `ci:dep-audit` (the allowlist and
  licences) and `ci:npm-audit`.

## Alternatives considered

| Alternative | Why not |
|---|---|
| `markdown-it` | Its dependency `argparse` is Python-2.0 licensed, which is not on the ADR-0014 §7 licence allowlist |
| `micromark` | 20+ packages |
| Our own parsers | Hand-written scanning is rejected (T24 §12); the spec parsers define the contexts |
| `DOMParser` | A Trusted Types sink (T18-005) |
| Either parse5 mode alone | Each misses a context the other covers (T24 §5.2) |
