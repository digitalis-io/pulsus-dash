//! Core WASM module (T03 §4.1): the render worker (OffscreenCanvas, wgpu, frame loop) and the
//! data worker of the #23 runtime spike.
//!
//! One crate, two artefacts (T03 §4.1, T03-022): `dash-core-mt` is built on the pinned nightly
//! with `+atomics` (one shared memory for render and data-0); `dash-core-st` is the same code on
//! stable, with its own memory, run as one worker. Code that differs uses
//! `cfg(target_feature = "atomics")`.

pub mod chunk;
pub mod control;
pub mod flags;
pub mod frame_input;
pub mod frame_stats;
pub mod line_load;
pub mod line_table;

#[cfg(target_arch = "wasm32")]
mod data;
#[cfg(target_arch = "wasm32")]
mod line_render;
#[cfg(all(target_arch = "wasm32", feature = "probe"))]
mod probe;
#[cfg(target_arch = "wasm32")]
mod render;
