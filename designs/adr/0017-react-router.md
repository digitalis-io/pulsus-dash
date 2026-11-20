# ADR-0017: React Router (data mode) replaces TanStack Router

| | |
|---|---|
| **Status** | Accepted (2026-11-19, product owner) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §1, the Routing row. The rest of ADR-0014 is unchanged |
| **Source** | Owner decision of 2026-11-19 on issue #57 |
| **See** | [T08](../technical/T08-dom-component-kit.md) T08-005; [T01](../technical/T01-frontend-architecture.md) §4.4 |

## Context

ADR-0014 §1 chose TanStack Router for typed routes and validated search parameters. Its runtime
closure includes `isbot`, licensed `Unlicense`, which is not on the licence allowlist of
ADR-0014 §7 (MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, MPL-2.0). Adding a licence to
that list is itself an architecture change; replacing the router is not.

## Decision

1. The client routes with **`react-router`** (MIT) in **data mode** only: code-based route objects,
   loaders and `lazy`, created with `createBrowserRouter` (tests: `createMemoryRouter`) and rendered
   client-side by `RouterProvider`. Framework mode, server-side rendering and the Vite plugin are
   not used.
2. **Search parameters are read and written only through typed modules** that validate, default and
   canonicalise them, so the URL reproduces the view (T08-005). For the time Context that module is
   `client/src/state/contextSearch.ts`; loaders `replace()` a non-canonical URL with its canonical
   form, which adds no history entry. ESLint bans `useSearchParams` and `createSearchParams` outside
   `client/src/state/`.

## Consequences

- Route and search typing is ours and is tested (`unit:context-search`, `unit:url-codec`), instead
  of being inferred by the router.
- The runtime closure grows by `react-router`, `cookie-es` and `@remix-run/route-pattern` (all MIT),
  about 5 KB brotli more than TanStack Router for the same routes; the initial JS budget of
  ADR-0014 §8 still holds.
- Product and technical text that named TanStack Router names React Router in data mode.
