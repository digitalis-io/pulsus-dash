# Font sources

Self-hosted WOFF2 files (VL-010, ADR-0014 §1), copied unchanged from the npm packages below. They
are not npm dependencies of the client: the files are committed and imported by `styles/fonts.css`.

| File | Package | Version | Licence | SHA-256 |
|---|---|---|---|---|
| `inter-latin-wght-normal.woff2` | `@fontsource-variable/inter` | 5.3.0 | OFL-1.1 (`OFL-Inter.txt`) | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| `jetbrains-mono-latin-wght-normal.woff2` | `@fontsource-variable/jetbrains-mono` | 5.3.0 | OFL-1.1 (`OFL-JetBrainsMono.txt`) | `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e` |

Verify with `sha256sum src/assets/fonts/*.woff2`.
