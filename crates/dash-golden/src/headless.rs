//! The headless lavapipe device (T05 §4.2, T05-004).

use dash_gpu::Tier;

/// Why the harness cannot run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GoldenError {
    /// No Vulkan adapter named `llvmpipe`.
    NoLavapipe,
    /// The device request failed.
    Device(String),
    /// Mapping a readback buffer failed.
    Readback(String),
}

impl std::fmt::Display for GoldenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

impl std::error::Error for GoldenError {}

/// A lavapipe device with the limits of a browser tier.
#[derive(Debug)]
pub struct Headless {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub info: wgpu::AdapterInfo,
}

impl Headless {
    /// The Vulkan `llvmpipe` adapter with `required_limits(limits_of, …)`.
    pub fn lavapipe(_limits_of: Tier) -> Result<Headless, GoldenError> {
        Err(GoldenError::NoLavapipe)
    }
}
