//! Seeded synthetic telemetry. Design: T05 §4.5 (T05-010): every generator is a pure function of
//! its seed, bit-identical on wasm32 and native (only `+ − × ÷ abs` on `f64`).
//!
//! #24 adds [`SplitMix64`] and the line presets ([`line`]).

pub mod line;
pub mod rng;

pub use rng::SplitMix64;
