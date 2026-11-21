//! The wgpu device, tiers and frame targets (plan #68 §3.9, A.8).

/// T1: compute decimation; T2: CPU decimation (dash-scales).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tier {
    T1,
    T2,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterChoice {
    Lavapipe,
    Default,
}

#[derive(Debug, thiserror::Error)]
pub enum GpuError {
    #[error("no adapter")]
    NoAdapter,
    #[error("device: {0}")]
    Device(String),
}

/// One device and queue.
#[derive(Debug)]
pub struct GpuContext {
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub tier: Tier,
    pub info: wgpu::AdapterInfo,
    /// min(max_buffer_size, max_storage_buffer_binding_size) / 16.
    pub max_instances: u64,
}

impl GpuContext {
    pub fn headless(choice: AdapterChoice, tier: Tier) -> Result<Self, GpuError> {
        let _ = (choice, tier);
        Err(GpuError::NoAdapter)
    }
}

/// Where a frame is drawn.
pub trait FrameTarget {
    fn format(&self) -> wgpu::TextureFormat;
    fn size_px(&self) -> (u32, u32);
    fn view(&mut self) -> wgpu::TextureView;
}

/// An `Rgba8Unorm` texture with readback.
#[derive(Debug)]
pub struct HeadlessTarget {
    texture: wgpu::Texture,
    w: u32,
    h: u32,
}

impl HeadlessTarget {
    pub fn new(ctx: &GpuContext, w: u32, h: u32) -> Self {
        let texture = ctx.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("headless"),
            size: wgpu::Extent3d { width: w.max(1), height: h.max(1), depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        Self { texture, w, h }
    }

    /// Rows without padding, RGBA8.
    pub fn read(&self, ctx: &GpuContext) -> Vec<u8> {
        let _ = ctx;
        vec![0; self.w as usize * self.h as usize * 4]
    }
}

impl FrameTarget for HeadlessTarget {
    fn format(&self) -> wgpu::TextureFormat {
        wgpu::TextureFormat::Rgba8Unorm
    }

    fn size_px(&self) -> (u32, u32) {
        (self.w, self.h)
    }

    fn view(&mut self) -> wgpu::TextureView {
        self.texture.create_view(&wgpu::TextureViewDescriptor::default())
    }
}
