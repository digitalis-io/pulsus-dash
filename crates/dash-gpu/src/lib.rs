//! GPU abstraction for the render worker: backend tier selection and device/surface setup
//! (PRF-044, T03 §9.2, T03-025).
//!
//! [`tier`] is the platform-independent selection logic; `web` (wasm32 only) creates the wgpu
//! device and surface on the transferred `OffscreenCanvas`.

pub mod tier;
#[cfg(target_arch = "wasm32")]
pub mod web;

pub use tier::{
    Fallback, Fault, ForcedMode, InitEnd, InitStage, Tier, after_failure, choose_format,
    start_code, tier_plan,
};
#[cfg(target_arch = "wasm32")]
pub use web::Gpu;
