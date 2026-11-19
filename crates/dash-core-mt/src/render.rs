//! The render worker (plan §4.5, T03-019, T03-007): `render_start` allocates the control block
//! and initialises the GPU tier; `render_frame` runs one frame on the worker's rAF. All state is
//! thread-local to the render worker (T03 §4.1 ownership); nothing here takes a lock shared with
//! another thread (T03-008).

use std::cell::{Cell, RefCell};
use std::sync::atomic::Ordering::{Relaxed, Release};

use dash_gpu::{Gpu, Tier, start_code, tier_plan};
use dash_marks::rect::RectPipeline;
use dash_protocol::input::{InputRecord, RecordHeader};
use dash_protocol::layout::{LAYOUT_VERSION, RING_BYTES, caps, off};
use dash_protocol::ring::RingView;
use dash_protocol::status::{RETRY_T2, RuntimeStatus};
use dash_scene::spike::SpikeScene;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::chunk::{self, InstanceChunk};
use crate::control::Control;
use crate::flags;
use crate::frame_input::{begin_frame, push_batch};
use crate::frame_stats::FrameStats;

/// Seed of the spike scene's instances.
pub(crate) const SPIKE_SEED: u64 = 7;

/// The most records one frame can drain (ring bytes / smallest record); the per-frame record
/// buffer is allocated once with this capacity, so draining never allocates.
const MAX_RECORDS_PER_FRAME: usize = RING_BYTES as usize / 16;

/// GPU copies of the pinned chunk's columns.
struct Instances {
    generation: u32,
    xy: wgpu::Buffer,
    phase: wgpu::Buffer,
    n: u32,
}

/// Everything the render worker owns once a tier is up.
pub(crate) struct Renderer {
    cb: Control,
    gpu: Gpu,
    pipeline: RectPipeline,
    canvas: web_sys::OffscreenCanvas,
    scene: SpikeScene,
    /// Consumer side of the input ring (frame start).
    ring: RingView,
    /// Producer side, used by `render_input` in ST mode only.
    producer: RingView,
    perf: web_sys::Performance,
    /// Worker `timeOrigin` − main `timeOrigin`: rebases worker times onto the main origin.
    origin_shift_ms: f64,
    instances: Option<Instances>,
    frame_no: u64,
    t_prev: Option<f64>,
    drained: Vec<(RecordHeader, InputRecord, u64)>,
    #[cfg(feature = "probe")]
    pub(crate) probe: crate::probe::ProbeState,
}

thread_local! {
    static CB: Cell<Option<Control>> = const { Cell::new(None) };
    static RENDER: RefCell<Option<Renderer>> = const { RefCell::new(None) };
}

/// The control block of this worker, once allocated.
pub(crate) fn control() -> Option<Control> {
    CB.with(Cell::get)
}

/// Runs `f` on the renderer, if a tier is up.
#[cfg(feature = "probe")]
pub(crate) fn with_renderer<T>(f: impl FnOnce(&mut Renderer) -> T) -> Option<T> {
    RENDER.with_borrow_mut(|r| r.as_mut().map(f))
}

fn global_get(name: &str) -> Option<JsValue> {
    js_sys::Reflect::get(&js_sys::global(), &JsValue::from_str(name))
        .ok()
        .filter(|v| !v.is_undefined())
}

fn has_navigator_gpu() -> bool {
    global_get("navigator")
        .and_then(|n| js_sys::Reflect::has(&n, &JsValue::from_str("gpu")).ok())
        .unwrap_or(false)
}

/// `?fault=` is honoured only in probe builds (T03-024).
fn fault(query: &str) -> Option<dash_gpu::Fault> {
    if cfg!(feature = "probe") {
        flags::parse_fault(query)
    } else {
        None
    }
}

/// Allocates the control block, initialises the GPU tiers of the plan and returns the
/// [`RuntimeStatus`] code, or `RETRY_T2` (plan §3.6, §4.2).
#[wasm_bindgen]
pub async fn render_start(
    canvas: web_sys::OffscreenCanvas,
    caps_bits: u32,
    main_time_origin: f64,
    query: String,
) -> u32 {
    let failed = RuntimeStatus::Failed as u32;
    let Some(cb) = Control::alloc() else {
        return failed;
    };
    cb.write_header(caps_bits);
    CB.with(|c| c.set(Some(cb)));
    #[cfg(not(target_feature = "atomics"))]
    chunk::publish(InstanceChunk {
        generation: 1,
        producer: "st",
        cols: dash_scene::spike::instances(SPIKE_SEED),
    });
    let Some(perf) =
        global_get("performance").and_then(|p| p.dyn_into::<web_sys::Performance>().ok())
    else {
        cb.set_status(failed);
        return failed;
    };
    let plan = tier_plan(flags::parse_query(&query), has_navigator_gpu());
    let result = Gpu::init(canvas.clone(), &plan, fault(&query)).await;
    let code = start_code(result.as_ref().map(|g| g.tier).map_err(|e| *e));
    if code != RETRY_T2 {
        cb.set_status(code);
    }
    if let Ok(gpu) = result {
        if gpu.tier == Tier::WebGl2 {
            cb.word(off::CAPS).fetch_or(caps::WEBGL2, Relaxed);
        }
        let pipeline = RectPipeline::new(&gpu.device, gpu.config.format);
        let renderer = Renderer {
            cb,
            pipeline,
            canvas,
            scene: SpikeScene::default(),
            ring: cb.input_ring(),
            producer: cb.input_ring(),
            origin_shift_ms: perf.time_origin() - main_time_origin,
            perf,
            instances: None,
            frame_no: 0,
            t_prev: None,
            drained: Vec::with_capacity(MAX_RECORDS_PER_FRAME),
            #[cfg(feature = "probe")]
            probe: crate::probe::ProbeState::new(),
            gpu,
        };
        RENDER.with_borrow_mut(|r| *r = Some(renderer));
    }
    #[cfg(feature = "probe")]
    crate::probe::install();
    code
}

/// Runs one frame at worker rAF time `t_ms`; `false` stops the loop (plan §4.5).
#[wasm_bindgen]
pub fn render_frame(t_ms: f64) -> bool {
    RENDER.with_borrow_mut(|r| r.as_mut().is_some_and(|r| r.frame(t_ms)))
}

/// The control block's `STATUS` word (Booting before `render_start` allocates it).
#[wasm_bindgen]
pub fn render_status() -> u32 {
    control().map_or(RuntimeStatus::Booting as u32, Control::status)
}

/// ST only: pushes one input batch (`len` bytes of records) into the ring, plus `dropped`
/// main-side drops (plan §4.4).
#[wasm_bindgen]
pub fn render_input(bytes: &[u8], dropped: u32) {
    RENDER.with_borrow_mut(|r| {
        if let Some(r) = r.as_mut() {
            push_batch(&mut r.producer, bytes, dropped);
        }
    });
}

/// The control block's address (0 before `render_start`).
#[wasm_bindgen]
pub fn control_block() -> u32 {
    control().map_or(0, |c| u32::try_from(c.addr()).unwrap_or(0))
}

#[wasm_bindgen]
pub fn layout_version() -> u32 {
    u32::from(LAYOUT_VERSION)
}

impl Renderer {
    fn input_paused(&self) -> bool {
        #[cfg(feature = "probe")]
        return self.probe.paused;
        #[cfg(not(feature = "probe"))]
        false
    }

    /// Steps 1–6 of plan §4.5.
    fn frame(&mut self, t: f64) -> bool {
        let cpu0 = self.perf.now();
        let next = self.frame_no + 1;
        if !self.input_paused() {
            self.drained.clear();
            begin_frame(
                &mut self.ring,
                &mut self.scene,
                next,
                Some(&mut self.drained),
            );
            for (_, rec, _) in &self.drained {
                if let InputRecord::Resize {
                    device_w, device_h, ..
                } = *rec
                {
                    self.gpu.resize(device_w, device_h);
                    self.canvas.set_width(self.gpu.config.width);
                    self.canvas.set_height(self.gpu.config.height);
                }
            }
            #[cfg(feature = "probe")]
            self.probe.log_input(&self.drained);
        }

        let pin = chunk::pin();
        if let Some(c) = &pin
            && self.instances.as_ref().map(|i| i.generation) != Some(c.generation)
        {
            self.instances = Some(self.upload(c));
        }

        let u = self.scene.uniforms(t);
        let frame = match self.gpu.surface.get_current_texture() {
            wgpu::CurrentSurfaceTexture::Success(f)
            | wgpu::CurrentSurfaceTexture::Suboptimal(f) => f,
            wgpu::CurrentSurfaceTexture::Outdated | wgpu::CurrentSurfaceTexture::Lost => {
                self.gpu.reconfigure();
                return true;
            }
            wgpu::CurrentSurfaceTexture::Timeout | wgpu::CurrentSurfaceTexture::Occluded => {
                return true;
            }
            wgpu::CurrentSurfaceTexture::Validation => {
                self.cb.set_status(RuntimeStatus::Failed as u32);
                return false;
            }
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
        {
            let [r, g, b, a] = dash_tokens::spike::CANVAS_BG;
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("spike"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color { r, g, b, a }),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            if let (Some(_), Some(i)) = (&pin, &self.instances) {
                self.pipeline
                    .draw(&mut pass, &self.gpu.queue, &u, &i.xy, &i.phase, i.n);
            }
        }
        self.gpu.queue.submit([encoder.finish()]);
        self.gpu.queue.present(frame);
        drop(pin);
        if self.gpu.is_lost() {
            self.cb.set_status(RuntimeStatus::Failed as u32);
            return false;
        }

        self.frame_no = next;
        let t_main = t + self.origin_shift_ms;
        self.cb.word64(off::FRAME_NO).store(next, Release);
        self.cb
            .word64(off::LAST_PRESENT_MS)
            .store(t_main.to_bits(), Release);
        self.cb
            .byte(off::VISIBLE)
            .store(u8::from(self.scene.visible()), Relaxed);
        if let Some(prev) = self.t_prev {
            FrameStats::new(&self.cb).record((t - prev) as f32, (self.perf.now() - cpu0) as f32);
        }
        self.t_prev = Some(t);
        #[cfg(feature = "probe")]
        self.probe.frame_start(next, t_main);
        true
    }

    /// Creates the instance buffers of a newly published chunk and writes them once.
    fn upload(&self, c: &InstanceChunk) -> Instances {
        let device = &self.gpu.device;
        let buffer = |label, bytes: &[u8]| {
            let b = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some(label),
                size: bytes.len() as wgpu::BufferAddress,
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            self.gpu.queue.write_buffer(&b, 0, bytes);
            b
        };
        Instances {
            generation: c.generation,
            xy: buffer("instances xy", bytemuck::cast_slice(&c.cols.xy)),
            phase: buffer("instances phase", bytemuck::cast_slice(&c.cols.phase)),
            n: u32::try_from(c.cols.xy.len().min(c.cols.phase.len())).unwrap_or(0),
        }
    }
}
