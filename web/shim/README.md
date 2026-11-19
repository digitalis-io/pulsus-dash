Shim files (T03 §5.1): `boot.js`, `worker.js` and `input.js`, each SHA-256-pinned in `ci/shim-pins.toml`; the others of T03 §5.1 come later.
`layout.gen.js` is generated from `dash-protocol` by `cargo xtask gen` and committed; it is accepted (unpinned, not counted) only while byte-identical to its generator.
Rules: T03-001 (≤ 300 non-blank, non-comment lines; imports only within `web/shim/`; no `eval`, `Function` or `innerHTML`).
`gen/` is git-ignored wasm-bindgen output (`dash-core-mt/`, `dash-core-st/`), accepted only when identical to a fresh build (regenerate-and-compare in `ci:dep-audit`).
Checked by `cargo xtask ci shim-lint` and `cargo xtask ci dep-audit`.
See [docs/runtime/browser-runtime.md](../../docs/runtime/browser-runtime.md) and [docs/development/build-and-ci.md](../../docs/development/build-and-ci.md).
