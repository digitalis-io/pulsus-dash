//! wgpu device and surface on an `OffscreenCanvas` (wasm32 only). Stub.

use crate::tier::{Fault, InitEnd, Tier};

/// The render worker's GPU: device, queue and configured surface of one tier.
#[derive(Debug)]
pub struct Gpu {
    pub tier: Tier,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
}

impl Gpu {
    pub async fn init(
        _canvas: web_sys::OffscreenCanvas,
        _plan: &[Tier],
        _fault: Option<Fault>,
    ) -> Result<Gpu, InitEnd> {
        Err(InitEnd::Static)
    }

    pub fn resize(&mut self, _device_w: u32, _device_h: u32) {}
}
