Only the five T03 §5.1 shim files may live here, each SHA-256-pinned in `ci/shim-pins.toml`.
Rules: T03-001 (≤ 300 non-blank, non-comment lines; imports only within `web/shim/`; no `eval`, `Function` or `innerHTML`).
`gen/` is git-ignored wasm-bindgen output; none is accepted until #23 adds its regenerate-and-compare check.
Checked by `cargo xtask ci shim-lint` and `cargo xtask ci dep-audit`.
See [docs/development/build-and-ci.md](../../docs/development/build-and-ci.md).
