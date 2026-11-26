//! The render worker's GPU (plan #68 C1 §4.1, §4.2): one device for every frame, WebGPU (T1) or,
//! with `forceT2` or when WebGPU has no adapter or device, WebGL2 (T2). On T1 each frame has its
//! own surface on its transferred `OffscreenCanvas`; on T2 every frame draws on one shared GL
//! surface at its own size and the result is transferred to the frame's `bitmaprenderer`.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use dash_gpu::{FrameTarget, GpuContext, Tier};
use wasm_bindgen::JsCast;

/// Why the GPU could not start.
#[derive(Debug, thiserror::Error)]
pub(crate) enum InitError {
    #[error("no adapter")]
    NoAdapter,
    #[error("device: {0}")]
    Device(String),
    #[error("surface: {0}")]
    Surface(String),
}

/// The device and what made it.
pub(crate) struct Gpu {
    pub(crate) ctx: GpuContext,
    pub(crate) adapter: wgpu::Adapter,
    pub(crate) instance: wgpu::Instance,
    /// T2: the shared GL canvas and its surface.
    pub(crate) shared: Option<Shared>,
    /// Set by the device-lost callback.
    pub(crate) lost: Arc<AtomicBool>,
}

impl std::fmt::Debug for Gpu {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Gpu")
            .field("tier", &self.ctx.tier)
            .field("adapter", &self.ctx.info.name)
            .finish()
    }
}

/// T2's one GL surface.
#[derive(Debug)]
pub(crate) struct Shared {
    pub(crate) canvas: web_sys::OffscreenCanvas,
    pub(crate) surface: wgpu::Surface<'static>,
    pub(crate) config: wgpu::SurfaceConfiguration,
}

fn instance(backends: wgpu::Backends) -> wgpu::InstanceDescriptor {
    let mut d = wgpu::InstanceDescriptor::new_without_display_handle();
    d.backends = backends;
    d
}

async fn device(
    adapter: &wgpu::Adapter,
    limits: wgpu::Limits,
) -> Result<(wgpu::Device, wgpu::Queue), InitError> {
    let desc = wgpu::DeviceDescriptor {
        label: Some("dash-render"),
        required_limits: limits,
        ..wgpu::DeviceDescriptor::default()
    };
    adapter
        .request_device(&desc)
        .await
        .map_err(|e| InitError::Device(e.to_string()))
}

/// The surface format: `Bgra8Unorm` or `Rgba8Unorm`, never sRGB (D-BLEND).
pub(crate) fn format(caps: &wgpu::SurfaceCapabilities) -> Option<wgpu::TextureFormat> {
    [
        wgpu::TextureFormat::Bgra8Unorm,
        wgpu::TextureFormat::Rgba8Unorm,
    ]
    .into_iter()
    .find(|f| caps.formats.contains(f))
}

fn watch(device: &wgpu::Device) -> Arc<AtomicBool> {
    let lost = Arc::new(AtomicBool::new(false));
    let l = lost.clone();
    device.set_device_lost_callback(move |_reason, _message| {
        l.store(true, Ordering::Release);
        // The frame loop may be idle: a tick handles the loss (review r1 #2).
        super::wake();
    });
    // Validation errors are logged, never a panic: a frame that fails reports `failed`.
    device.on_uncaptured_error(Arc::new(|e: wgpu::Error| {
        web_sys::console::warn_1(&format!("pulsus engine: {e}").into());
    }));
    lost
}

/// T1: WebGPU with the adapter's buffer limits (the instance buffer may be as large as allowed).
async fn webgpu() -> Result<Gpu, InitError> {
    let instance =
        wgpu::util::new_instance_with_webgpu_detection(instance(wgpu::Backends::BROWSER_WEBGPU))
            .await;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await
        .map_err(|_| InitError::NoAdapter)?;
    let al = adapter.limits();
    let limits = wgpu::Limits {
        max_buffer_size: al.max_buffer_size,
        max_storage_buffer_binding_size: al.max_storage_buffer_binding_size,
        ..wgpu::Limits::default()
    };
    let (device, queue) = device(&adapter, limits).await?;
    let lost = watch(&device);
    let ctx = GpuContext::from_device(device, queue, Tier::T1, adapter.get_info());
    Ok(Gpu {
        ctx,
        adapter,
        instance,
        shared: None,
        lost,
    })
}

/// T2: WebGL2 on one shared `OffscreenCanvas` (a GL adapter needs a surface).
async fn webgl2() -> Result<Gpu, InitError> {
    let instance = wgpu::Instance::new(instance(wgpu::Backends::GL));
    let canvas = web_sys::OffscreenCanvas::new(1, 1)
        .map_err(|_| InitError::Surface("OffscreenCanvas".into()))?;
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
        .map_err(|e| InitError::Surface(e.to_string()))?;
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions {
            compatible_surface: Some(&surface),
            ..Default::default()
        })
        .await
        .map_err(|_| InitError::NoAdapter)?;
    let limits = wgpu::Limits::downlevel_webgl2_defaults().using_resolution(adapter.limits());
    let (device, queue) = device(&adapter, limits).await?;
    let caps = surface.get_capabilities(&adapter);
    let format = format(&caps).ok_or_else(|| InitError::Surface("no unorm format".into()))?;
    let config = wgpu::SurfaceConfiguration {
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        format,
        width: 1,
        height: 1,
        present_mode: wgpu::PresentMode::Fifo,
        desired_maximum_frame_latency: 2,
        alpha_mode: wgpu::CompositeAlphaMode::Auto,
        view_formats: Vec::new(),
        color_space: wgpu::SurfaceColorSpace::Auto,
    };
    surface.configure(&device, &config);
    let lost = watch(&device);
    let ctx = GpuContext::from_device(device, queue, Tier::T2, adapter.get_info());
    Ok(Gpu {
        ctx,
        adapter,
        instance,
        shared: Some(Shared {
            canvas,
            surface,
            config,
        }),
        lost,
    })
}

impl Gpu {
    /// WebGPU unless `force_t2`, else (or when it fails) WebGL2.
    pub(crate) async fn init(force_t2: bool) -> Result<Gpu, InitError> {
        if !force_t2 {
            match webgpu().await {
                Ok(g) => return Ok(g),
                Err(e) => web_sys::console::warn_1(
                    &format!("pulsus engine: WebGPU unavailable ({e}); trying WebGL2").into(),
                ),
            }
        }
        webgl2().await
    }

    /// The adapter as `<html data-dash-adapter>` shows it.
    pub(crate) fn adapter_text(&self) -> String {
        let i = &self.ctx.info;
        [i.name.as_str(), i.driver.as_str(), i.driver_info.as_str()]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("; ")
    }
}

/// A surface texture as a frame target.
pub(crate) struct SurfaceTarget {
    pub(crate) texture: wgpu::SurfaceTexture,
    pub(crate) format: wgpu::TextureFormat,
    pub(crate) size: (u32, u32),
}

impl FrameTarget for SurfaceTarget {
    fn format(&self) -> wgpu::TextureFormat {
        self.format
    }
    fn size_px(&self) -> (u32, u32) {
        self.size
    }
    fn view(&mut self) -> wgpu::TextureView {
        self.texture
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default())
    }
}

/// The `bitmaprenderer` context of a T2 frame's canvas.
pub(crate) fn bitmap_context(
    canvas: &web_sys::OffscreenCanvas,
) -> Option<web_sys::ImageBitmapRenderingContext> {
    canvas
        .get_context("bitmaprenderer")
        .ok()
        .flatten()?
        .dyn_into::<web_sys::ImageBitmapRenderingContext>()
        .ok()
}
