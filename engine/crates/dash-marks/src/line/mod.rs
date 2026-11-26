//! The M1 line mark: decimation passes and the capsule pipeline (feature `gpu`).

mod defer;
mod gpu;
mod pipeline;
mod t1;

pub use gpu::{DebugCounters, Pending, Renderer, RendererOptions, Sync};
