//! The M1 line mark: decimation passes and the capsule pipeline (feature `gpu`).

mod gpu;
mod pipeline;

pub use gpu::{DebugCounters, Renderer, RendererOptions};
