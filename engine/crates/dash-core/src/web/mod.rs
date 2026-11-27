//! The render worker's wasm-bindgen exports (plan #68 C1 §3.3, §4.1–§4.3). All state lives in one
//! thread-local `Engine` on the render worker (T03 §4.1 ownership); messages from the main thread
//! mark frames dirty and the worker's animation frame runs `engine_tick`, which builds, draws and
//! presents the dirty frames and returns their events as one JSON array. Nothing here waits on
//! another thread's lock (T03-008); decimation on T2 joins its own rayon tasks on the pool.
//!
//! Part C2a1 (§4.2, §4.3): each tick starts by draining the input ring (the camera and the size
//! of the frames, T03-019) and ends with one `applied` per frame whose records it applied. A
//! presentation is captured when its draw list is submitted; a deferred one waits in `awaiting`
//! with its capture, and its `drawn` reports that capture once the read-back says it is complete.
//! When nothing is left to do, `engine_wants_frame` marks the worker idle and re-checks the ring.
//! The `probe` feature (the probe build only, T03-024) logs the decoded records for
//! `e2e:shim-fuzz`.
//!
//! Part C2b (§4.3): the `select` events of the drained records go out first, then each dirty
//! frame's build output (`hover`, `a11y`), the completions (`stage`, `drawn`) and `applied`. The
//! probe build can hold a frame after one presentation (`engine_probe_freeze`), so `e2e:engine-hover`
//! H1b screenshots exactly that presentation.
//!
//! Part C2d2 (§3.2): the single-thread engine (`st`, `dash-core-st`) has no pool and no shared
//! memory; main cannot write its ring, so input comes as batches of the same records
//! (`engine_input_batch`), queued here and applied at the start of the next tick, after the
//! ring's (empty) drain.
//!
//! Plan #68 D2 (§3.2, MT only): the DSF decode service (`crate::decode`) and its chunk table.
//! `engine_decode_*` feed it; `engine_decode_take` (at tick start) returns its results for the
//! worker to post; `frame_set_chunk_ref` makes a table chunk a frame's data, and
//! `engine_chunk_release` drops a collected array's entry. While decodes run the loop keeps ticking.

mod control;
mod gpu;
#[cfg(feature = "mt")]
mod pool;

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::sync::atomic::Ordering;

use dash_gpu::Tier;
use dash_marks::line::{Pending, Renderer, RendererOptions, Sync};
use dash_marks::{DrawList, DrawnEvent};
use dash_protocol::{Status, caps, off};
use dash_scene::Theme;
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::*;

use crate::events::{self, FailReason};
use crate::frames::{Frames, Presented};
use crate::input::{self, Decoded};
use crate::recovery::{LossAction, LossPolicy, Restored, restore_events, restored};
use control::Control;
use gpu::{Gpu, SurfaceTarget, bitmap_context, format};

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
    /// Presentations waiting for their status read-back, with what they show.
    awaiting: BTreeMap<u32, Presented>,
    failed: BTreeSet<u32>,
    /// The records drained this tick (kept for its capacity).
    inbox: Vec<Decoded>,
    /// ST input batches' records, queued until the next tick (plan #68 C2d2 §3.2).
    batched: Vec<Decoded>,
    /// Bad records found while queuing a batch, counted at the next tick.
    batch_bad: u32,
    /// A rejected input record was logged (once per worker).
    bad_logged: bool,
    #[cfg(feature = "probe")]
    probe: Vec<serde_json::Value>,
    /// The probe build: frames held after a presentation of at least this seq (`true`: reached).
    #[cfg(feature = "probe")]
    freeze: BTreeMap<u32, (u32, bool)>,
    /// Events produced outside a tick (a surface that could not be made).
    queued: Vec<String>,
    frame_no: u64,
    losses: LossPolicy,
    restoring: bool,
    dead: bool,
    /// The boot epoch (`BOOT_EPOCH`): every chunk reference carries it.
    #[cfg(feature = "mt")]
    epoch: u32,
    /// Plan #68 D2: the DSF decodes and the chunk table (MT).
    #[cfg(feature = "mt")]
    decode: crate::decode::DecodeService,
}

thread_local! {
    static ENGINE: RefCell<Option<Engine>> = const { RefCell::new(None) };
    /// The worker's wake-up (`engine_on_wake`): schedules an animation frame when the loop is idle.
    static WAKE: RefCell<Option<js_sys::Function>> = const { RefCell::new(None) };
}

/// Wakes the render loop (a device loss or a finished restore while no frame was dirty).
pub(crate) fn wake() {
    WAKE.with_borrow(|w| {
        if let Some(f) = w {
            let _ = f.call0(&JsValue::NULL);
        }
    });
}

/// The function that schedules the next animation frame; called when the engine needs a tick
/// outside the frame loop (device loss, restore).
#[wasm_bindgen]
pub fn engine_on_wake(wake: &js_sys::Function) {
    WAKE.with_borrow_mut(|w| *w = Some(wake.clone()));
}

/// A frame's data changed (replaced, cleared, disposed): a chunk it held may be unheld now, so the
/// table's unheld cap is enforced at once (plan #68 D2, review r1 #1).
#[cfg(feature = "mt")]
fn data_changed(e: &mut Engine) {
    e.decode.table_mut().enforce_cap();
}

#[cfg(not(feature = "mt"))]
fn data_changed(_: &mut Engine) {}

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
                    awaiting: BTreeMap::new(),
                    failed: BTreeSet::new(),
                    inbox: Vec::new(),
                    batched: Vec::new(),
                    batch_bad: 0,
                    bad_logged: false,
                    #[cfg(feature = "probe")]
                    probe: Vec::new(),
                    #[cfg(feature = "probe")]
                    freeze: BTreeMap::new(),
                    queued: Vec::new(),
                    frame_no: 0,
                    losses: LossPolicy::default(),
                    restoring: false,
                    dead: false,
                    #[cfg(feature = "mt")]
                    epoch,
                    #[cfg(feature = "mt")]
                    decode: crate::decode::DecodeService::new(epoch),
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

/// The frame's event markers' times, ms (`EventMarker.atMs` in call order, NaN kept; plan #68 C2c1
/// §3.3): a layer input, so the frame is rebuilt.
#[wasm_bindgen]
pub fn frame_set_events(id: u32, at_ms: Vec<f64>) {
    with(|e| {
        e.dirty.insert(id);
        e.frames.set_events(id, at_ms);
    });
}

/// The page selection (plan #68 C2c2 §3.1): its keys (only 16 lower-case hex digits can match a
/// series key), and its interval; a layer input, so the frame is rebuilt.
#[wasm_bindgen]
pub fn frame_set_selection(id: u32, keys: Vec<String>, from_ms: Option<f64>, to_ms: Option<f64>) {
    let s = dash_scene::SelectionIn::new(keys.iter().map(String::as_str), from_ms, to_ms);
    with(|e| {
        e.dirty.insert(id);
        e.frames.set_selection(id, s);
    });
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
        let r = e.frames.data_end(id);
        data_changed(e);
        r
    })
    .unwrap_or(Ok(()))
    .map_err(|err| JsError::new(&err.to_string()))
}

#[wasm_bindgen]
pub fn frame_data_clear(id: u32) {
    with(|e| {
        e.dirty.insert(id);
        e.frames.data_clear(id);
        data_changed(e);
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

#[wasm_bindgen]
pub fn frame_dispose(id: u32) {
    with(|e| {
        e.frames.dispose(id);
        e.gpus.remove(&id);
        e.dirty.remove(&id);
        e.awaiting.remove(&id);
        e.failed.remove(&id);
        data_changed(e);
    });
}

/// One animation frame at `now_ms` (main time origin): the events as a JSON array, or "".
#[wasm_bindgen]
pub fn engine_tick(now_ms: f64) -> String {
    with(|e| e.tick(now_ms)).unwrap_or_default()
}

/// Whether another animation frame is needed (dirty, awaiting a read-back, events queued, or a
/// device loss); otherwise the worker goes idle unless the input ring has records
/// (`input::before_sleep`): then it ticks again.
#[wasm_bindgen]
pub fn engine_wants_frame() -> bool {
    with(|e| {
        if e.dead {
            return false;
        }
        #[cfg(feature = "mt")]
        let decoding = e.decode.busy();
        #[cfg(not(feature = "mt"))]
        let decoding = false;
        let busy = decoding
            || !e.dirty.is_empty()
            || !e.batched.is_empty()
            || !e.awaiting.is_empty()
            || !e.queued.is_empty()
            || e.gpu.lost.load(Ordering::Acquire);
        busy || input::before_sleep(&e.cb)
    })
    .unwrap_or(false)
}

/// One input batch of the single-thread engine (plan #68 C2d2 §3.2): its records are decoded
/// (`input::drain_batch`) and queued, and the next tick applies them first (T03-019). A bad record
/// counts in `INPUT_BAD` and skips the rest of the batch. Returns the records queued.
#[cfg(feature = "st")]
#[wasm_bindgen]
pub fn engine_input_batch(bytes: &[u8]) -> u32 {
    with(|e| {
        let before = e.batched.len();
        if let Err(bad) = input::drain_batch(bytes, &mut e.batched) {
            e.batch_bad += 1;
            if !e.bad_logged {
                e.bad_logged = true;
                web_sys::console::error_1(&format!("pulsus engine: {bad} (batch)").into());
            }
        }
        u32::try_from(e.batched.len() - before).unwrap_or(u32::MAX)
    })
    .unwrap_or(0)
}

/// Plan #68 D2 §3.1: a DSF decode begins (`busy` beyond two in flight).
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn engine_decode_begin(req: u32) {
    with(|e| {
        e.decode.begin(req);
        e.decode.pump();
    });
}

/// One fetch read of decode `req`, of any size (copied into slabs here).
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn engine_decode_chunk(req: u32, bytes: &[u8]) {
    with(|e| {
        e.decode.push(req, bytes);
        e.decode.pump();
    });
}

/// The end of decode `req`'s body.
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn engine_decode_end(req: u32) {
    with(|e| {
        e.decode.end(req);
        e.decode.pump();
    });
}

/// Decode `req`'s fetch was aborted: its queue, decoder and chunks are dropped.
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn engine_decode_abort(req: u32) {
    with(|e| e.decode.abort(req));
}

#[cfg(feature = "mt")]
fn set(o: &js_sys::Object, k: &str, v: &JsValue) {
    let _ = js_sys::Reflect::set(o, &JsValue::from_str(k), v);
}

#[cfg(feature = "mt")]
fn json_or_null(v: Option<&serde_json::Value>) -> JsValue {
    v.map_or(JsValue::NULL, |v| JsValue::from_str(&v.to_string()))
}

/// The decode results since the last call, as the messages the worker posts (§3.1): `decode-credit`
/// `{req, bytes}`; `decoded` `{req, chunk, epoch, head (JSON), ts, vs}`; `decode-failed` `{req,
/// kind, message, row, coverage (JSON or null), planned}`. Called at tick start.
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn engine_decode_take() -> js_sys::Array {
    use crate::decode::Done;
    let out = js_sys::Array::new();
    let done = with(|e| e.decode.take_done()).unwrap_or_default();
    for d in done {
        let o = js_sys::Object::new();
        match d {
            Done::Credit { req, bytes } => {
                set(&o, "t", &"decode-credit".into());
                set(&o, "req", &req.into());
                set(&o, "bytes", &JsValue::from_f64(bytes as f64));
            }
            Done::Decoded(m) => {
                set(&o, "t", &"decoded".into());
                set(&o, "req", &m.req.into());
                set(&o, "chunk", &m.chunk.into());
                set(&o, "epoch", &m.epoch.into());
                set(&o, "head", &JsValue::from_str(&m.head.to_string()));
                set(
                    &o,
                    "ts",
                    &js_sys::Float64Array::from(m.ts.as_slice()).into(),
                );
                let vs = js_sys::Array::new();
                for v in &m.vs {
                    vs.push(&js_sys::Float64Array::from(v.as_slice()).into());
                }
                set(&o, "vs", &vs.into());
            }
            Done::Failed(f) => {
                set(&o, "t", &"decode-failed".into());
                set(&o, "req", &f.req.into());
                set(&o, "kind", &f.kind.as_str().into());
                set(&o, "message", &f.message.as_str().into());
                set(&o, "row", &json_or_null(f.row.as_ref()));
                set(&o, "coverage", &json_or_null(f.coverage.as_ref()));
                set(
                    &o,
                    "planned",
                    &f.planned
                        .as_deref()
                        .map_or(JsValue::NULL, JsValue::from_str),
                );
            }
        }
        out.push(&o);
    }
    out
}

/// `setData` by reference (plan #68 D2 §4.2): the table's chunk `chunk` of epoch `epoch` becomes
/// frame `id`'s data (`Frames::set_chunk`); false when it is of another epoch or was evicted (the
/// worker answers `chunk-missing`).
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn frame_set_chunk_ref(id: u32, chunk: u32, epoch: u32) -> bool {
    with(|e| {
        let Some(c) = e.decode.table_mut().get(epoch, chunk) else {
            return false;
        };
        e.frames.set_chunk(id, Some(c));
        e.dirty.insert(id);
        data_changed(e);
        true
    })
    .unwrap_or(false)
}

/// A registered series array was collected: its table entry goes (another epoch's is ignored).
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn engine_chunk_release(chunk: u32, epoch: u32) {
    with(|e| e.decode.table_mut().release(epoch, chunk));
}

/// The chunk table's entries and bytes, `{count, bytes}` JSON (the probe's `chunks()`).
#[cfg(feature = "mt")]
#[wasm_bindgen]
pub fn engine_chunk_stats() -> String {
    with(|e| {
        let t = e.decode.table();
        serde_json::json!({
            "count": t.len(),
            "bytes": t.bytes(),
            "unheld": t.unheld_bytes(),
            "inflight": e.decode.in_flight(),
            "epoch": e.epoch,
        })
        .to_string()
    })
    .unwrap_or_else(|| "null".to_owned())
}

/// The probe log's bound.
#[cfg(feature = "probe")]
const PROBE_LOG: usize = 20_000;

/// The probe build: the decoded input records so far (at most `PROBE_LOG`), as a JSON array in
/// the adapter's `InputRec` shape (`input::log_json`).
#[cfg(feature = "probe")]
#[wasm_bindgen]
pub fn engine_probe_input() -> String {
    with(|e| serde_json::Value::Array(e.probe.clone()).to_string()).unwrap_or_default()
}

/// The probe build: head = tail = `v` before the first record (`e2e:shim-fuzz` rollover).
#[cfg(feature = "probe")]
#[wasm_bindgen]
pub fn engine_probe_ring_start(v: u32) {
    use crate::input::Words;
    with(|e| {
        Words::store(&e.cb, off::INPUT_HEAD, v, Ordering::SeqCst);
        Words::store(&e.cb, off::INPUT_TAIL, v, Ordering::SeqCst);
    });
}

/// The probe build (plan #68 C2b §3.4): after its first completed presentation with seq ≥ `seq`,
/// the worker builds and presents nothing for frame `id` (records are still applied and acked)
/// until `engine_probe_unfreeze`.
#[cfg(feature = "probe")]
#[wasm_bindgen]
pub fn engine_probe_freeze(id: u32, seq: u32) {
    with(|e| {
        e.freeze.insert(id, (seq, false));
    });
}

/// The probe build: releases frame `id`; it is drawn again at the next tick.
#[cfg(feature = "probe")]
#[wasm_bindgen]
pub fn engine_probe_unfreeze(id: u32) {
    with(|e| {
        if e.freeze.remove(&id).is_some() && e.gpus.contains_key(&id) {
            e.dirty.insert(id);
        }
    });
}

/// The probe build (plan #68 C2c2 S11): every frame's renderer and surface configuration are
/// dropped and the frames redrawn, as the same-tier restore after a device loss does, so each
/// renderer (and its dim layer) is made again.
#[cfg(feature = "probe")]
#[wasm_bindgen]
pub fn engine_probe_renew() {
    with(|e| {
        for (id, fg) in e.gpus.iter_mut() {
            fg.renderer = None;
            fg.config = None;
            e.dirty.insert(*id);
        }
    });
}

/// The probe build (plan #68 C2d1 §3.2): F1c (`series` × `points` on a grid) built in the worker
/// as frame `id`'s data (`Frames::synth_f1c`); the bytes of values it holds, 0 when it failed (an
/// allocation, an unknown frame), and then the frame is unchanged.
#[cfg(feature = "probe")]
#[wasm_bindgen]
pub fn engine_probe_synth(id: u32, series: u32, points: u32) -> u32 {
    with(|e| {
        if !e.frames.synth_f1c(id, series, points) {
            return 0;
        }
        e.dirty.insert(id);
        // At most 2³¹ samples were made; a byte count past u32 saturates.
        let bytes = u64::from(series) * u64::from(points) * 8;
        u32::try_from(bytes).unwrap_or(u32::MAX)
    })
    .unwrap_or(0)
}

/// The probe build (plan #68 C2d1 §3.2): frame `id`'s chunk as JSON `{series, points, bytes}`
/// (points: the samples of series 0; bytes: of all values), or `null` without one.
#[cfg(feature = "probe")]
#[wasm_bindgen]
pub fn engine_probe_chunk(id: u32) -> String {
    with(|e| {
        e.frames.chunk(id).map_or_else(
            || "null".to_owned(),
            |c| {
                let points = c.offsets.get(1).copied().unwrap_or(0);
                serde_json::json!({
                    "series": c.series.len(),
                    "points": points,
                    "bytes": c.values.len() * 8,
                })
                .to_string()
            },
        )
    })
    .unwrap_or_else(|| "null".to_owned())
}

/// The device px of a Resize, at least 1 and at most the device's texture limit.
fn device_px(px: u32, max: u32) -> u32 {
    px.clamp(1, max.max(1))
}

impl Engine {
    fn create(&mut self, id: u32, canvas: web_sys::OffscreenCanvas, frame_id: Option<String>) {
        if !self.frames.create(id, frame_id) {
            // The adapter's ids are never reused (plan #68 C2a1 §3.1): no `created`.
            web_sys::console::error_1(
                &format!("pulsus engine: frame {id} is not above the highest id seen").into(),
            );
            return;
        }
        self.queued.push(events::created(id));
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
        self.read_input();
        out.extend(self.frames.take_events());
        self.draw_frames(now_ms, t0, &mut out);
        out.extend(self.frames.take_applied());
        events::batch(&out)
    }

    /// The input ring's records, applied in order (T03-019); rejected records are counted in
    /// `INPUT_BAD` and the first one is logged.
    fn read_input(&mut self) {
        self.inbox.clear();
        let drained = input::drain(&self.cb, &mut self.inbox);
        // ST: the batches queued since the last tick, after the ring's records (none in ST).
        self.inbox.append(&mut self.batched);
        let batch_bad = std::mem::take(&mut self.batch_bad);
        let bad_before = self.frames.bad();
        for d in &self.inbox {
            #[cfg(feature = "probe")]
            if self.probe.len() < PROBE_LOG {
                self.probe.push(input::log_json(d));
            }
            if let Some(id) = self.frames.apply(d) {
                self.dirty.insert(id);
            }
        }
        let bad =
            self.frames.bad().wrapping_sub(bad_before) + u32::from(drained.is_err()) + batch_bad;
        if bad > 0 {
            self.cb.add(off::INPUT_BAD, bad);
            if !self.bad_logged {
                self.bad_logged = true;
                let what = match drained {
                    Err(e) => e.to_string(),
                    Ok(()) => "a record out of range".to_owned(),
                };
                web_sys::console::error_1(&format!("pulsus engine: {what}").into());
            }
        }
    }

    /// The device-loss policy, the read-backs and the dirty frames of one tick.
    fn draw_frames(&mut self, now_ms: f64, t0: f64, out: &mut Vec<String>) {
        if self.gpu.lost.load(Ordering::Acquire) && !self.restoring {
            match self.losses.on_lost(now_ms) {
                LossAction::Fatal => {
                    self.dead = true;
                    out.push(events::fatal("device-lost"));
                    return;
                }
                LossAction::Restore => self.restore(),
            }
        }
        if self.restoring {
            return;
        }
        let mut done: Vec<(u32, Presented)> = Vec::new();
        // Read-backs first: a complete presentation reports its capture, never the current
        // state; an under-sized one is drawn again (and captured again).
        for (id, p) in std::mem::take(&mut self.awaiting) {
            let Some(r) = self.gpus.get_mut(&id).and_then(|g| g.renderer.as_mut()) else {
                continue;
            };
            match r.poll() {
                Pending::Waiting => {
                    self.awaiting.insert(id, p);
                }
                Pending::Complete(_) => done.push((id, p)),
                Pending::Rerun => {
                    self.dirty.insert(id);
                }
                Pending::Failed => self.fail(id, FailReason::Readback),
                Pending::Idle => {}
            }
        }
        out.append(&mut self.queued);
        let mut presented = false;
        for id in std::mem::take(&mut self.dirty) {
            if self.failed.contains(&id) || !self.gpus.contains_key(&id) {
                continue;
            }
            #[cfg(feature = "probe")]
            if self.freeze.get(&id).is_some_and(|z| z.1) {
                // Held: drawn again once unfrozen.
                self.dirty.insert(id);
                continue;
            }
            let Some((list, a11y, hover)) = self.frames.build(id) else {
                continue;
            };
            if let Some(h) = hover {
                out.push(h);
            }
            if let Some(j) = a11y {
                out.push(events::a11y(id, &j));
            }
            if !(list.css.0 > 0.0 && list.css.1 > 0.0) {
                continue;
            }
            let Some(p) = self.frames.submit(id) else {
                continue;
            };
            match self.draw(id, &list) {
                Ok(Some(_)) => {
                    presented = true;
                    done.push((id, p));
                }
                Ok(None) => {
                    presented = true;
                    self.awaiting.insert(id, p);
                }
                Err(Skip::Retry) => {
                    self.dirty.insert(id);
                }
                Err(Skip::Fail(reason)) => self.fail(id, reason),
            }
        }
        out.append(&mut self.queued);
        let end_ms = now_ms + (now() - t0).max(0.0);
        for (id, p) in done {
            #[cfg(feature = "probe")]
            if let Some(z) = self.freeze.get_mut(&id)
                && dash_protocol::input::seq_ge(p.seq, z.0)
            {
                z.1 = true;
            }
            // What the presentation shows, never 0 (ADR-0019, D-DRAWN).
            out.extend(self.frames.complete(id, &p, now_ms, end_ms));
        }
        if presented {
            self.frame_no += 1;
            self.cb.write_clock(self.frame_no, end_ms);
        }
    }

    /// Draws and presents one frame: `Ok(Some)` complete, `Ok(None)` complete only once its
    /// read-back says so.
    fn draw(&mut self, id: u32, list: &DrawList) -> Result<Option<DrawnEvent>, Skip> {
        let max = self.gpu.ctx.device.limits().max_texture_dimension_2d;
        let (_, _, (w, h)) = self.frames.size(id).ok_or(Skip::Retry)?;
        let size = (device_px(w, max), device_px(h, max));
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

    /// The device was lost (first time in 60 s): a new device. On the same tier every frame is
    /// redrawn on its canvas; on another tier (T1 lost, only WebGL2 left) the frames fall back to
    /// Canvas 2D (`failed{tier}`) and later frames use the new tier; with no device, `fatal`.
    fn restore(&mut self) {
        self.restoring = true;
        let old = self.gpu.ctx.tier;
        wasm_bindgen_futures::spawn_local(async move {
            let gpu = Gpu::init(old == Tier::T2).await;
            with(|e| {
                e.restoring = false;
                let outcome = restored(old, gpu.as_ref().ok().map(|g| g.ctx.tier));
                let ids = e.frames.ids();
                let adapter = gpu.as_ref().map(Gpu::adapter_text).unwrap_or_default();
                e.queued.extend(restore_events(&ids, outcome, &adapter));
                match (outcome, gpu) {
                    (Restored::Same, Ok(g)) => {
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
                        e.dirty.extend(ids);
                    }
                    (Restored::TierChanged(_), Ok(g)) => {
                        // `restore_events` reported each frame failed: drop their GPU side.
                        e.gpu = g;
                        for id in ids {
                            e.failed.insert(id);
                            e.gpus.remove(&id);
                            e.dirty.remove(&id);
                            e.awaiting.remove(&id);
                        }
                    }
                    _ => e.dead = true,
                }
            });
            // The loop may be idle: the next tick posts the events and redraws.
            wake();
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
