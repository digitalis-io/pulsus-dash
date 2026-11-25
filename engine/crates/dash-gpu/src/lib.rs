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
    /// Instances one buffer can hold (16 bytes each): T1 min(max_buffer_size,
    /// max_storage_buffer_binding_size) / 16, as the compute passes bind the instance buffer; T2
    /// max_buffer_size / 16 (no storage binding).
    pub max_instances: u64,
    /// Test hook: waits left before `wait` fails (`u64::MAX` = never).
    wait_budget: std::sync::atomic::AtomicU64,
    /// Test hook: deferred maps left before they report failure (`u64::MAX` = never).
    map_budget: std::sync::atomic::AtomicU64,
}

fn instance() -> wgpu::Instance {
    wgpu::Instance::new(wgpu::InstanceDescriptor {
        backends: wgpu::Backends::VULKAN,
        ..wgpu::InstanceDescriptor::new_without_display_handle()
    })
}

impl GpuContext {
    /// Native: the Vulkan backend; `Lavapipe` selects the adapter whose `driver` is "llvmpipe"
    /// (T05-004). The device requests the adapter's `max_buffer_size` and
    /// `max_storage_buffer_binding_size`, so `max_instances` is as large as the adapter allows.
    pub fn headless(choice: AdapterChoice, tier: Tier) -> Result<Self, GpuError> {
        let instance = instance();
        let adapters = pollster::block_on(instance.enumerate_adapters(wgpu::Backends::VULKAN));
        let adapter = match choice {
            AdapterChoice::Lavapipe => adapters
                .into_iter()
                .find(|a| a.get_info().driver == "llvmpipe"),
            AdapterChoice::Default => adapters.into_iter().next(),
        }
        .ok_or(GpuError::NoAdapter)?;
        let al = adapter.limits();
        let required_limits = wgpu::Limits {
            max_buffer_size: al.max_buffer_size,
            max_storage_buffer_binding_size: al.max_storage_buffer_binding_size,
            ..wgpu::Limits::default()
        };
        let desc = wgpu::DeviceDescriptor {
            label: Some("dash-gpu"),
            required_features: wgpu::Features::empty(),
            required_limits,
            ..wgpu::DeviceDescriptor::default()
        };
        let (device, queue) = pollster::block_on(adapter.request_device(&desc))
            .map_err(|e| GpuError::Device(e.to_string()))?;
        Ok(Self::from_device(device, queue, tier, adapter.get_info()))
    }

    /// A context on a device the caller requested (the render worker's path).
    pub fn from_device(
        device: wgpu::Device,
        queue: wgpu::Queue,
        tier: Tier,
        info: wgpu::AdapterInfo,
    ) -> Self {
        let l = device.limits();
        let max_instances = match tier {
            Tier::T1 => l.max_buffer_size.min(l.max_storage_buffer_binding_size) / 16,
            Tier::T2 => l.max_buffer_size / 16,
        };
        Self {
            wait_budget: std::sync::atomic::AtomicU64::new(u64::MAX),
            map_budget: std::sync::atomic::AtomicU64::new(u64::MAX),
            device,
            queue,
            tier,
            info,
            max_instances,
        }
    }

    /// Whether a completed deferred map may be used: false once the `fail_maps_after` budget is
    /// spent (test hook; always true otherwise).
    pub fn take_map(&self) -> bool {
        use std::sync::atomic::Ordering;
        match self.map_budget.load(Ordering::Relaxed) {
            0 => false,
            u64::MAX => true,
            _ => {
                self.map_budget.fetch_sub(1, Ordering::Relaxed);
                true
            }
        }
    }

    /// Test hook: every deferred map after the next `n` successful ones reports failure.
    #[cfg(feature = "test-hooks")]
    pub fn fail_maps_after(&self, n: u64) {
        self.map_budget
            .store(n, std::sync::atomic::Ordering::Relaxed);
    }

    /// The Vulkan adapters this process sees (name, driver, driver info), for error messages.
    pub fn adapter_list() -> Vec<String> {
        let adapters = pollster::block_on(instance().enumerate_adapters(wgpu::Backends::VULKAN));
        adapters
            .iter()
            .map(|a| {
                let i = a.get_info();
                format!("{} [{}; {}]", i.name, i.driver, i.driver_info)
            })
            .collect()
    }

    /// Blocks until the queue is idle (native).
    pub fn wait(&self) -> Result<(), GpuError> {
        use std::sync::atomic::Ordering;
        match self.wait_budget.load(Ordering::Relaxed) {
            0 => return Err(GpuError::Device("wait failed (injected)".into())),
            u64::MAX => {}
            _ => {
                self.wait_budget.fetch_sub(1, Ordering::Relaxed);
            }
        }
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .map(|_| ())
            .map_err(|e| GpuError::Device(e.to_string()))
    }

    /// Test hook: every `wait` after the next `n` successful ones fails with `GpuError::Device`.
    pub fn fail_waits_after(&self, n: u64) {
        self.wait_budget
            .store(n, std::sync::atomic::Ordering::Relaxed);
    }

    /// Copies `size` bytes of `src` from `offset` and maps them (blocking, native).
    pub fn read_buffer(
        &self,
        src: &wgpu::Buffer,
        offset: u64,
        size: u64,
    ) -> Result<Vec<u8>, GpuError> {
        if size == 0 {
            return Ok(Vec::new());
        }
        let read = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("readback"),
            size,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        enc.copy_buffer_to_buffer(src, offset, &read, 0, size);
        self.queue.submit([enc.finish()]);
        self.map_read(&read)
    }

    /// Maps a MAP_READ buffer and returns its bytes (blocking, native).
    pub fn map_read(&self, read: &wgpu::Buffer) -> Result<Vec<u8>, GpuError> {
        let (tx, rx) = std::sync::mpsc::channel();
        read.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            let _ = tx.send(r);
        });
        self.wait()?;
        match rx.recv() {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(GpuError::Device(e.to_string())),
            Err(e) => return Err(GpuError::Device(e.to_string())),
        }
        let bytes = read
            .slice(..)
            .get_mapped_range()
            .map(|v| v.to_vec())
            .map_err(|e| GpuError::Device(e.to_string()));
        read.unmap();
        bytes
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
            size: wgpu::Extent3d {
                width: w.max(1),
                height: h.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        Self { texture, w, h }
    }

    /// Rows without padding, RGBA8; empty when the read back fails or the size is zero.
    pub fn read(&self, ctx: &GpuContext) -> Vec<u8> {
        if self.w == 0 || self.h == 0 {
            return Vec::new();
        }
        let row = self.w * 4;
        let padded =
            row.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
        let buf = ctx.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("headless readback"),
            size: u64::from(padded) * u64::from(self.h),
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut enc = ctx
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        enc.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buf,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded),
                    rows_per_image: Some(self.h),
                },
            },
            wgpu::Extent3d {
                width: self.w,
                height: self.h,
                depth_or_array_layers: 1,
            },
        );
        ctx.queue.submit([enc.finish()]);
        let Ok(bytes) = ctx.map_read(&buf) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity((row * self.h) as usize);
        for y in 0..self.h as usize {
            out.extend_from_slice(&bytes[y * padded as usize..y * padded as usize + row as usize]);
        }
        out
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
        self.texture
            .create_view(&wgpu::TextureViewDescriptor::default())
    }
}
