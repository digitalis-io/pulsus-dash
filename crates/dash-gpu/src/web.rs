//! wgpu device and surface on the transferred `OffscreenCanvas` (wasm32 only; plan §3.5).
//!
//! | Tier | Steps | Stage of a failure |
//! |---|---|---|
//! | WebGPU | instance (WebGPU detection), adapter, device | before the surface |
//! | | `create_surface` | before (no context was created) |
//! | | capabilities, format, `configure` in an error scope | after the surface |
//! | WebGL2 | instance (GL), `create_surface` | before the surface |
//! | | adapter, device, capabilities, `configure` | after the surface |

use std::cell::Cell;

use crate::tier::{Fallback, Fault, InitEnd, InitStage, Tier, after_failure, choose_format};

thread_local! {
    /// Set by the device-lost callback; read once per frame.
    static LOST: Cell<bool> = const { Cell::new(false) };
}

/// The render worker's GPU: device, queue and configured surface of one tier.
#[derive(Debug)]
pub struct Gpu {
    pub tier: Tier,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub surface: wgpu::Surface<'static>,
    pub config: wgpu::SurfaceConfiguration,
}

fn instance_desc(backends: wgpu::Backends) -> wgpu::InstanceDescriptor {
    let mut d = wgpu::InstanceDescriptor::new_without_display_handle();
    d.backends = backends;
    d
}

/// The canvas size, at least 1 × 1.
fn canvas_size(canvas: &web_sys::OffscreenCanvas) -> (u32, u32) {
    (canvas.width().max(1), canvas.height().max(1))
}

async fn request_device(adapter: &wgpu::Adapter) -> Option<(wgpu::Device, wgpu::Queue)> {
    let desc = wgpu::DeviceDescriptor {
        label: Some("dash-render"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::downlevel_webgl2_defaults()
            .using_resolution(adapter.limits()),
        ..Default::default()
    };
    let (device, queue) = adapter.request_device(&desc).await.ok()?;
    device.set_device_lost_callback(|_reason, _message| LOST.with(|l| l.set(true)));
    Some((device, queue))
}

/// Capabilities → format → `configure` inside a validation error scope.
async fn configure(
    adapter: &wgpu::Adapter,
    device: &wgpu::Device,
    surface: &wgpu::Surface<'static>,
    (width, height): (u32, u32),
) -> Option<wgpu::SurfaceConfiguration> {
    let caps = surface.get_capabilities(adapter);
    let format = choose_format(&caps.formats)?;
    let mut config = surface.get_default_config(adapter, width, height)?;
    config.format = format;
    config.present_mode = wgpu::PresentMode::Fifo;
    config.alpha_mode = caps
        .alpha_modes
        .first()
        .copied()
        .unwrap_or(wgpu::CompositeAlphaMode::Auto);
    config.view_formats = Vec::new();
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    surface.configure(device, &config);
    match scope.pop().await {
        None => Some(config),
        Some(_) => None,
    }
}

async fn webgpu(canvas: &web_sys::OffscreenCanvas, fault: Option<Fault>) -> Result<Gpu, InitStage> {
    use InitStage::{AfterSurface, BeforeSurface};
    let instance = wgpu::util::new_instance_with_webgpu_detection(instance_desc(
        wgpu::Backends::BROWSER_WEBGPU,
    ))
    .await;
    let options = wgpu::RequestAdapterOptions {
        compatible_surface: None,
        ..Default::default()
    };
    let adapter = instance
        .request_adapter(&options)
        .await
        .map_err(|_| BeforeSurface)?;
    let (device, queue) = request_device(&adapter).await.ok_or(BeforeSurface)?;
    if fault == Some(Fault::WebGpuBeforeSurface) {
        return Err(BeforeSurface);
    }
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
        .map_err(|_| BeforeSurface)?;
    if fault == Some(Fault::WebGpuAfterSurface) {
        return Err(AfterSurface);
    }
    let config = configure(&adapter, &device, &surface, canvas_size(canvas))
        .await
        .ok_or(AfterSurface)?;
    Ok(Gpu {
        tier: Tier::WebGpu,
        device,
        queue,
        surface,
        config,
    })
}

async fn webgl2(canvas: &web_sys::OffscreenCanvas) -> Result<Gpu, InitStage> {
    use InitStage::{AfterSurface, BeforeSurface};
    let instance = wgpu::Instance::new(instance_desc(wgpu::Backends::GL));
    let surface = instance
        .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
        .map_err(|_| BeforeSurface)?;
    let options = wgpu::RequestAdapterOptions {
        compatible_surface: Some(&surface),
        ..Default::default()
    };
    let adapter = instance
        .request_adapter(&options)
        .await
        .map_err(|_| AfterSurface)?;
    let (device, queue) = request_device(&adapter).await.ok_or(AfterSurface)?;
    let config = configure(&adapter, &device, &surface, canvas_size(canvas))
        .await
        .ok_or(AfterSurface)?;
    Ok(Gpu {
        tier: Tier::WebGl2,
        device,
        queue,
        surface,
        config,
    })
}

impl Gpu {
    /// Tries `plan` in order on `canvas` (plan §3.5): a failure before the surface falls through
    /// to the next tier in place; after it, initialisation ends with a restart (the canvas holds
    /// a context of the failed tier) or Static. `fault` injects test failures (probe builds).
    pub async fn init(
        canvas: web_sys::OffscreenCanvas,
        plan: &[Tier],
        fault: Option<Fault>,
    ) -> Result<Gpu, InitEnd> {
        let mut i = 0;
        while let Some(tier) = plan.get(i) {
            let r = match tier {
                Tier::WebGpu => webgpu(&canvas, fault).await,
                Tier::WebGl2 => webgl2(&canvas).await,
            };
            let stage = match r {
                Ok(gpu) => return Ok(gpu),
                Err(stage) => stage,
            };
            match after_failure(stage, plan.get(i + 1..).unwrap_or(&[])) {
                Fallback::TryNext(_) => i += 1,
                Fallback::End(end) => return Err(end),
            }
        }
        Err(InitEnd::Static)
    }

    /// Reconfigures the surface for a new device-pixel size, clamped to
    /// [1, `max_texture_dimension_2d`].
    pub fn resize(&mut self, device_w: u32, device_h: u32) {
        let max = self.device.limits().max_texture_dimension_2d.max(1);
        let (w, h) = (device_w.clamp(1, max), device_h.clamp(1, max));
        if (w, h) != (self.config.width, self.config.height) {
            self.config.width = w;
            self.config.height = h;
            self.surface.configure(&self.device, &self.config);
        }
    }

    /// Reapplies the current configuration (after a lost or outdated surface texture).
    pub fn reconfigure(&self) {
        self.surface.configure(&self.device, &self.config);
    }

    /// True once the device-lost callback has run.
    pub fn is_lost(&self) -> bool {
        LOST.with(Cell::get)
    }
}
