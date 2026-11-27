# ADR-0035: The platform UI face on Apple systems; Inter and JetBrains Mono stay self-hosted; amends 0014 §1 (fonts)

| | |
|---|---|
| **Status** | Accepted on merge of #282 Part 1 (owner request 2026-11-27) |
| **Amends** | [ADR-0014](0014-typescript-react-web-client.md) §1 (fonts: self-hosted Inter for UI text, JetBrains Mono for data): on Apple systems the DOM's UI text uses the system UI face. The rest of §1 is unchanged |
| **Source** | Issue #282 (visual refresh, owner request 2026-11-27) |
| **See** | [08](../product/08-visual-language.md) VL-010, VL-011; [T08](../technical/T08-dom-component-kit.md) §4.7; [ADR-0016](0016-asset-integrity-verified-by-bff.md); [T05](../technical/T05-testing-and-performance.md) §7.1 (`e2e:font-origin`, `unit:platform-face`) |

## Context

The visual refresh of #282 aims at the finish of a native Mac application. On Apple systems, Inter
in the chrome reads as a web page beside the system's own controls and menus. ADR-0014 §1 fixed
Inter for every UI string and required every font to be self-hosted, for air-gapped deployments and
a strict CSP (ADR-0016).

## Decision

1. **Detection.** Before the first render the client sets `html[data-platform="apple"]` when
   `navigator.userAgentData.platform`, or without it `navigator.platform`, starts with `mac`,
   `iphone`, `ipad` or `ipod` (iPadOS reports `MacIntel`), and removes it otherwise. A failure
   leaves the attribute unset.
2. **The face.** Under `data-platform="apple"`, `--font-ui` is the token `font.family.ui-apple`
   (`-apple-system, BlinkMacSystemFont, "Inter Variable", system-ui, sans-serif`) and the Inter
   letter-spacing tokens are 0, because the system face tracks itself. Elsewhere `--font-ui` stays
   self-hosted Inter.
3. **Data and canvas.** Data and code stay JetBrains Mono on every platform. Canvas text (Canvas 2D
   and the engine's future glyph atlas) stays Inter and JetBrains Mono on every platform, so charts
   look the same everywhere (VL-011).
4. **Origins.** Inter and JetBrains Mono stay self-hosted and same-origin. The system face is the
   operating system's own and is never fetched. No other font origin is allowed.

## Alternatives rejected

- **Inter everywhere** (ADR-0014 as it was): consistent, but on Apple systems it is the web-page
  look the refresh replaces.
- **Bundling the system face**: its licence does not allow redistribution.
- **`system-ui` everywhere**: on Linux it resolves to whatever the distribution ships, so text
  metrics, goldens and the pinned test hosts would vary; the gates run on Linux with Inter.

## Consequences

- On Apple systems the DOM never asks for Inter, but the Canvas 2D engine still loads it on chart
  init and redraws once it arrives (`e2e:font-origin`, Apple legs).
- DOM and canvas text use different faces on Apple systems; VL-011's match applies to canvas text
  against Inter.
- The Linux gates and goldens keep Inter, since the attribute is never set there.
