//! The render worker's wasm-bindgen exports (plan #68 C1 §3.3, §4.1–§4.3). All state lives in one
//! thread-local `Engine` on the render worker (T03 §4.1 ownership); messages from the main thread
//! mark frames dirty and the worker's animation frame runs `engine_tick`, which builds, draws and
//! presents the dirty frames and returns their events as one JSON array. Nothing here waits on
//! another thread's lock (T03-008); decimation on T2 joins its own rayon tasks on the pool.

mod control;
mod gpu;
mod pool;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::sync::atomic::Ordering;

use dash_gpu::Tier;
use dash_marks::line::{Pending, Renderer, RendererOptions, Sync};
use dash_marks::{DrawList, DrawnEvent, MarkItem};
use dash_protocol::{Status, caps};
use dash_scene::Theme;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::events::{self, FailReason};
use crate::frames::Frames;
use control::Control;
use gpu::{Gpu, SurfaceTarget, bitmap_context, format};

/// A second device loss within this window ends the engine (plan #68 C1 §4.3).
const LOST_AGAIN_MS: f64 = 60_000.0;

/// What `engine_start` returns: the runtime status (1 T1, 2 T2, 4 Failed) and the control block's
/// address.
#[wasm_bindgen]
#[derive(Debug)]
pub struct BootStatus {
    pub status: u32,
    pub cb: u32,
    adapter: String,
}

#[wasm_bindgen]
impl BootStatus {
    /// The adapter (`<html data-dash-adapter>`); "" when the GPU did not start.
    #[wasm_bindgen(getter)]
    pub fn adapter(&self) -> String {
        self.adapter.clone()
    }
}

/// The GPU side of one frame.
struct FrameGpu {
    canvas: web_sys::OffscreenCanvas,
    /// T1: the frame's own surface and its configuration.
    surface: Option<wgpu::Surface<'static>>,
    config: Option<wgpu::SurfaceConfiguration>,
    /// T2: where the shared surface's image goes.
    bitmap: Option<web_sys::ImageBitmapRenderingContext>,
    renderer: Option<Renderer>,
    /// Set when a configure failed validation.
    surface_bad: Rc<Cell<bool>>,
}

/// Why a frame was not drawn this tick.
enum Skip {
    /// Try again next frame (an outdated or busy surface).
    Retry,
    Fail(FailReason),
}

struct Engine {
    cb: Control,
    gpu: Gpu,
    frames: Frames,
    gpus: BTreeMap<u32, FrameGpu>,
    dirty: BTreeSet<u32>,
    awaiting: BTreeSet<u32>,
    failed: BTreeSet<u32>,
    /// Events produced outside a tick (a surface that could not be made).
    queued: Vec<String>,
    frame_no: u64,
    lost_at: Option<f64>,
    restoring: bool,
    dead: bool,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
}

fn with<T>(f: impl FnOnce(&mut Engine) -> T) -> Option<T> {
    ENGINE.with_borrow_mut(|e| e.as_mut().map(f))
}

fn now() -> f64 {
    js_sys::global()
        .dyn_into::<web_sys::WorkerGlobalScope>()
        .ok()
        .and_then(|g| g.performance())
        .map_or(0.0, |p| p.now())
}

/// Allocates the control block and starts the GPU: WebGPU (status 1) unless `force_t2`, else
/// or failing that WebGL2 (status 2); neither is status 4.
#[wasm_bindgen]
pub async fn engine_start(force_t2: bool, caps_bits: u32, epoch: u32) -> BootStatus {
    let cb = Control::alloc();
    cb.write_header(caps_bits, epoch);
    let status = match Gpu::init(force_t2).await {
        Ok(gpu) => {
            let status = match gpu.ctx.tier {
                Tier::T1 => Status::TierT1,
                Tier::T2 => Status::TierT2,
            };
            if gpu.ctx.tier == Tier::T2 {
                cb.or_caps(caps::WEBGL2);
            }
            let adapter = gpu.adapter_text();
            ENGINE.with_borrow_mut(|e| {
                *e = Some(Engine {
                    cb,
                    gpu,
                    frames: Frames::new(),
                    gpus: BTreeMap::new(),
                    dirty: BTreeSet::new(),
                    awaiting: BTreeSet::new(),
                    failed: BTreeSet::new(),
                    queued: Vec::new(),
                    frame_no: 0,
                    lost_at: None,
                    restoring: false,
                    dead: false,
                });
            });
            cb.set_status(status);
            return BootStatus {
                status: status as u32,
                cb: cb.addr(),
                adapter,
            };
        }
        Err(e) => {
            web_sys::console::warn_1(&format!("pulsus engine: no GPU ({e})").into());
            Status::Failed
        }
    };
    cb.set_status(status);
    BootStatus {
        status: status as u32,
        cb: cb.addr(),
        adapter: String::new(),
    }
}

/// A new engine frame on its transferred canvas.
#[wasm_bindgen]
pub fn frame_create(
    id: u32,
    canvas: web_sys::OffscreenCanvas,
    frame_id: Option<String>,
) -> Result<(), JsError> {
    with(|e| e.create(id, canvas, frame_id)).ok_or_else(|| JsError::new("engine not started"))
}

#[wasm_bindgen]
pub fn frame_set_spec(id: u32, json: &str) -> Result<(), JsError> {
    with(|e| {
        e.dirty.insert(id);
        e.frames.set_spec(id, json)
    })
    .unwrap_or(Ok(()))
    .map_err(|err| JsError::new(&err.to_string()))
}

#[wasm_bindgen]
pub fn frame_data_begin(id: u32) {
    with(|e| e.frames.data_begin(id));
}

/// One series of the frame's data: `key` is 16 lower-case hex digits; `names` and `values` are
/// the labels; `t_ms` and `v` have the same length.
#[wasm_bindgen]
pub fn frame_data_series(
    id: u32,
    key: &str,
    names: Vec<String>,
    values: Vec<String>,
    t_ms: &[f64],
    v: &[f64],
) -> Result<(), JsError> {
    with(|e| e.frames.data_series(id, key, names, values, t_ms, v))
        .unwrap_or(Ok(()))
        .map_err(|err| JsError::new(&err.to_string()))
}

/// Ends the frame's data: the chunk becomes the frame's data (`Frames::set_chunk`).
#[wasm_bindgen]
pub fn frame_data_end(id: u32) -> Result<(), JsError> {
    with(|e| {
        e.dirty.insert(id);
        e.frames.data_end(id)
    })
    .unwrap_or(Ok(()))
    .map_err(|err| JsError::new(&err.to_string()))
}

#[wasm_bindgen]
pub fn frame_data_clear(id: u32) {
    with(|e| {
        e.dirty.insert(id);
        e.frames.data_clear(id);
    });
}

#[wasm_bindgen]
pub fn frame_set_window(id: u32, from_ms: f64, to_ms: f64) {
    with(|e| {
        e.dirty.insert(id);
        e.frames.set_window(id, from_ms, to_ms);
    });
}

/// 0 dark, 1 light.
#[wasm_bindgen]
pub fn frame_set_theme(id: u32, theme: u8) {
    let theme = if theme == 1 {
        Theme::Light
    } else {
        Theme::Dark
    };
    with(|e| {
        e.dirty.insert(id);
        e.frames.set_theme(id, theme);
    });
}

/// CSS px and DPR (a message until C2's input ring carries Resize records).
#[wasm_bindgen]
pub fn frame_resize(id: u32, css_w: f64, css_h: f64, dpr: f64) {
    with(|e| {
        e.dirty.insert(id);
        e.frames.resize(id, css_w, css_h, dpr as f32);
    });
}

#[wasm_bindgen]
pub fn frame_dispose(id: u32) {
    with(|e| {
        e.frames.dispose(id);
        e.gpus.remove(&id);
        e.dirty.remove(&id);
        e.awaiting.remove(&id);
        e.failed.remove(&id);
    });
}

/// One animation frame at `now_ms` (main time origin): the events as a JSON array, or "".
#[wasm_bindgen]
pub fn engine_tick(now_ms: f64) -> String {
    with(|e| e.tick(now_ms)).unwrap_or_default()
}

/// Whether another animation frame is needed (dirty, awaiting a read-back, or events queued).
#[wasm_bindgen]
pub fn engine_wants_frame() -> bool {
    with(|e| {
        !e.dead
            && (!e.dirty.is_empty()
                || !e.awaiting.is_empty()
                || !e.queued.is_empty()
                || e.gpu.lost.load(Ordering::Acquire))
    })
    .unwrap_or(false)
}

/// Series a draw list draws.
fn series_of(list: &DrawList) -> u32 {
    list.items
        .iter()
        .map(|i| match i {
            MarkItem::Line { series, .. } => series.end.saturating_sub(series.start),
            MarkItem::Guides { .. } => 0,
        })
        .sum()
}

/// `round(css × dpr)`, at least 1 and at most the device's texture limit.
fn device_px(css: f64, dpr: f32, max: u32) -> u32 {
    ((css * f64::from(dpr)).round().max(1.0) as u32).min(max.max(1))
}

impl Engine {
    fn create(&mut self, id: u32, canvas: web_sys::OffscreenCanvas, frame_id: Option<String>) {
        self.frames.create(id, frame_id);
        self.failed.remove(&id);
        let (surface, bitmap) = match self.gpu.ctx.tier {
            Tier::T1 => match self
                .gpu
                .instance
                .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(canvas.clone()))
            {
                Ok(s) => (Some(s), None),
                Err(err) => {
                    web_sys::console::warn_1(&format!("pulsus engine: surface ({err})").into());
                    self.fail(id, FailReason::Surface);
                    return;
                }
            },
            Tier::T2 => match bitmap_context(&canvas) {
                Some(b) => (None, Some(b)),
                None => {
                    self.fail(id, FailReason::Surface);
                    return;
                }
            },
        };
        self.gpus.insert(
            id,
            FrameGpu {
                canvas,
                surface,
                config: None,
                bitmap,
                renderer: None,
                surface_bad: Rc::new(Cell::new(false)),
            },
        );
        self.dirty.insert(id);
    }

    /// The frame falls back: `failed` is reported once and it is drawn no more.
    fn fail(&mut self, id: u32, reason: FailReason) {
        if self.failed.insert(id) {
            self.queued.push(events::failed(id, reason));
        }
        self.gpus.remove(&id);
        self.dirty.remove(&id);
        self.awaiting.remove(&id);
    }

    fn renderer_options() -> RendererOptions {
        RendererOptions {
            max_instances: None,
            sync: Sync::Defer,
        }
    }

    fn tick(&mut self, now_ms: f64) -> String {
        let t0 = now();
        let mut out = std::mem::take(&mut self.queued);
        if self.dead {
            return events::batch(&out);
        }
        if self.gpu.lost.load(Ordering::Acquire) && !self.restoring {
            if self.lost_at.is_some_and(|t| now_ms - t < LOST_AGAIN_MS) {
                self.dead = true;
                out.push(events::fatal("device-lost"));
                return events::batch(&out);
            }
            self.lost_at = Some(now_ms);
            self.restore();
        }
        if self.restoring {
            return events::batch(&out);
        }
        let mut drawn: Vec<(u32, DrawnEvent, u32)> = Vec::new();
        // Read-backs first: a complete frame is drawn; an under-sized one is drawn again.
        for id in self.awaiting.clone() {
            let Some(r) = self.gpus.get_mut(&id).and_then(|g| g.renderer.as_mut()) else {
                self.awaiting.remove(&id);
                continue;
            };
            match r.poll() {
                Pending::Waiting => {}
                Pending::Complete(d) => {
                    self.awaiting.remove(&id);
                    if let Some((list, _)) = self.frames.build(id) {
                        drawn.push((id, d, series_of(&list)));
                    }
                }
                Pending::Rerun => {
                    self.awaiting.remove(&id);
                    self.dirty.insert(id);
                }
                Pending::Failed => {
                    self.fail(id, FailReason::Readback);
                }
                Pending::Idle => {
                    self.awaiting.remove(&id);
                }
            }
        }
        out.append(&mut self.queued);
        let mut presented = false;
        for id in std::mem::take(&mut self.dirty) {
            if self.failed.contains(&id) || !self.gpus.contains_key(&id) {
                continue;
            }
            let Some((list, a11y)) = self.frames.build(id) else {
                continue;
            };
            if let Some(j) = a11y {
                out.push(events::a11y(id, &j));
            }
            if !(list.css.0 > 0.0 && list.css.1 > 0.0) {
                continue;
            }
            match self.draw(id, &list) {
                Ok(Some(d)) => {
                    presented = true;
                    drawn.push((id, d, series_of(&list)));
                }
                Ok(None) => {
                    presented = true;
                    self.awaiting.insert(id);
                }
                Err(Skip::Retry) => {
                    self.dirty.insert(id);
                }
                Err(Skip::Fail(reason)) => self.fail(id, reason),
            }
        }
        out.append(&mut self.queued);
        let end_ms = now_ms + (now() - t0).max(0.0);
        for (id, d, series) in drawn {
            // Only at the size last applied, never 0 (ADR-0019, D-DRAWN).
            let size = self.frames.size(id);
            let at_size = size.is_some_and(|(w, h, _)| w == d.css_width && h == d.css_height);
            if at_size && d.css_width > 0.0 && d.css_height > 0.0 {
                out.push(events::drawn(id, &d, now_ms, end_ms, series));
            }
        }
        if presented {
            self.frame_no += 1;
            self.cb.write_clock(self.frame_no, end_ms);
        }
        events::batch(&out)
    }

    /// Draws and presents one frame: `Ok(Some)` complete, `Ok(None)` complete only once its
    /// read-back says so.
    fn draw(&mut self, id: u32, list: &DrawList) -> Result<Option<DrawnEvent>, Skip> {
        let max = self.gpu.ctx.device.limits().max_texture_dimension_2d;
        let size = (
            device_px(list.css.0, list.dpr, max),
            device_px(list.css.1, list.dpr, max),
        );
        let Some(fg) = self.gpus.get_mut(&id) else {
            return Err(Skip::Fail(FailReason::Surface));
        };
        if fg.surface_bad.get() {
            return Err(Skip::Fail(FailReason::Surface));
        }
        let ctx = &self.gpu.ctx;
        match (fg.surface.as_ref(), self.gpu.shared.as_mut()) {
            (Some(surface), _) => {
                let format = match fg.config.as_ref() {
                    Some(c) => c.format,
                    None => format(&surface.get_capabilities(&self.gpu.adapter))
                        .ok_or(Skip::Fail(FailReason::Surface))?,
                };
                if fg
                    .config
                    .as_ref()
                    .is_none_or(|c| (c.width, c.height) != size)
                {
                    let config = wgpu::SurfaceConfiguration {
                        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                        format,
                        width: size.0,
                        height: size.1,
                        present_mode: wgpu::PresentMode::Fifo,
                        desired_maximum_frame_latency: 2,
                        alpha_mode: wgpu::CompositeAlphaMode::Opaque,
                        view_formats: Vec::new(),
                        color_space: wgpu::SurfaceColorSpace::Auto,
                    };
                    configure(&ctx.device, surface, &config, fg.surface_bad.clone());
                    fg.config = Some(config);
                }
                let texture = match surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(t)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
                    wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                        fg.config = None;
                        return Err(Skip::Retry);
                    }
                    wgpu::CurrentSurfaceTexture::Validation => {
                        return Err(Skip::Fail(FailReason::Surface));
                    }
                    _ => return Err(Skip::Retry),
                };
                let r = fg
                    .renderer
                    .get_or_insert_with(|| Renderer::new(ctx, format, Self::renderer_options()));
                let mut target = SurfaceTarget {
                    texture,
                    format,
                    size,
                };
                let d = r.render(ctx, list, &mut target);
                ctx.queue.present(target.texture);
                Ok(d)
            }
            (None, Some(shared)) => {
                if (shared.config.width, shared.config.height) != size {
                    shared.config.width = size.0;
                    shared.config.height = size.1;
                    shared.surface.configure(&ctx.device, &shared.config);
                }
                let texture = match shared.surface.get_current_texture() {
                    wgpu::CurrentSurfaceTexture::Success(t)
                    | wgpu::CurrentSurfaceTexture::Suboptimal(t) => t,
                    wgpu::CurrentSurfaceTexture::Validation => {
                        return Err(Skip::Fail(FailReason::Surface));
                    }
                    _ => return Err(Skip::Retry),
                };
                let format = shared.config.format;
                let r = fg
                    .renderer
                    .get_or_insert_with(|| Renderer::new(ctx, format, Self::renderer_options()));
                let mut target = SurfaceTarget {
                    texture,
                    format,
                    size,
                };
                let d = r.render(ctx, list, &mut target);
                ctx.queue.present(target.texture);
                let bitmap = shared
                    .canvas
                    .transfer_to_image_bitmap()
                    .map_err(|_| Skip::Fail(FailReason::Surface))?;
                fg.canvas.set_width(size.0);
                fg.canvas.set_height(size.1);
                if let Some(b) = fg.bitmap.as_ref() {
                    b.transfer_from_image_bitmap(&bitmap);
                }
                Ok(d)
            }
            (None, None) => Err(Skip::Fail(FailReason::Surface)),
        }
    }

    /// The device was lost (first time in 60 s): a new device on the same canvases, every frame
    /// redrawn.
    fn restore(&mut self) {
        self.restoring = true;
        let force_t2 = self.gpu.ctx.tier == Tier::T2;
        wasm_bindgen_futures::spawn_local(async move {
            let gpu = Gpu::init(force_t2).await;
            with(|e| {
                e.restoring = false;
                match gpu {
                    Ok(g) => {
                        e.gpu = g;
                        for fg in e.gpus.values_mut() {
                            fg.renderer = None;
                            fg.config = None;
                            if fg.surface.is_some() {
                                fg.surface = e
                                    .gpu
                                    .instance
                                    .create_surface(wgpu::SurfaceTarget::OffscreenCanvas(
                                        fg.canvas.clone(),
                                    ))
                                    .ok();
                            }
                        }
                        e.awaiting.clear();
                        let ids = e.frames.ids();
                        e.dirty.extend(ids);
                    }
                    Err(_) => {
                        e.dead = true;
                        e.queued.push(events::fatal("device-lost"));
                    }
                }
            });
        });
    }
}

/// `surface.configure` in a validation error scope; a failure marks the frame's surface bad (the
/// next tick reports `failed{surface}`).
fn configure(
    device: &wgpu::Device,
    surface: &wgpu::Surface<'static>,
    config: &wgpu::SurfaceConfiguration,
    bad: Rc<Cell<bool>>,
) {
    let scope = device.push_error_scope(wgpu::ErrorFilter::Validation);
    surface.configure(device, config);
    let popped = scope.pop();
    wasm_bindgen_futures::spawn_local(async move {
        if popped.await.is_some() {
            bad.set(true);
        }
    });
}
