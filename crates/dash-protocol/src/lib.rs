//! The main ↔ worker protocol of the browser runtime (T03 §4.3, §5.4, §9.3): the control block
//! v1 layout and its generated JS mirror, runtime status codes, input records and the SPSC ring.
//!
//! No dependencies: shared by the core (both artefacts), the tests and `xtask` (which generates
//! `web/shim/layout.gen.js` from [`layout::render_js`]).

pub mod input;
pub mod layout;
pub mod ring;
pub mod status;
