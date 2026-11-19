//! The test probe (feature `probe` only; T03-024: never in release builds, checked by
//! `ci:probe-absent`). Installed on the render worker's global as `self.__dashProbe`.
//!
//! | Method | Returns |
//! |---|---|
//! | `status()` | the control block's `STATUS` |
//! | `frameStats()` | `{frames, longFrames, hist[64], intervalsMs[], cpuMs[]}` (oldest first) |
//! | `frameStarts()` | the last 256 `{frame, tMainMs}` |
//! | `inputLog()` | the last 8 192 drained records `{kind, flags, seq, tMs, x, y, frame}` |
//! | `threads()` | `{sharedMemory, instancesPublishedBy}` |
//! | `pauseInput(b)` | stops / resumes draining the input ring |
//! | `overflowCount()` | `INPUT_OVERFLOW` |

use std::collections::VecDeque;
use std::sync::atomic::Ordering::Relaxed;

use dash_protocol::input::{InputRecord, RecordHeader};
use dash_protocol::layout::off;
use wasm_bindgen::JsCast;
use wasm_bindgen::closure::WasmClosure;
use wasm_bindgen::prelude::*;

use crate::frame_stats::{HIST_BUCKETS, RECENT};
use crate::render::{control, with_renderer};

/// The global the probe is installed under.
pub const PROBE_GLOBAL: &str = "__dashProbe";

const INPUT_LOG: usize = 8192;
const FRAME_STARTS: usize = 256;

/// One drained record as the probe reports it.
#[derive(Clone, Copy, Debug)]
struct Logged {
    kind: u8,
    flags: u8,
    seq: u32,
    t_ms: f64,
    x: f32,
    y: f32,
    frame: u64,
}

/// Probe-only state of the render worker.
#[derive(Debug)]
pub(crate) struct ProbeState {
    pub(crate) paused: bool,
    input: VecDeque<Logged>,
    starts: VecDeque<(u64, f64)>,
}

impl ProbeState {
    pub(crate) fn new() -> Self {
        ProbeState {
            paused: false,
            input: VecDeque::with_capacity(INPUT_LOG),
            starts: VecDeque::with_capacity(FRAME_STARTS),
        }
    }

    pub(crate) fn log_input(&mut self, drained: &[(RecordHeader, InputRecord, u64)]) {
        for (h, r, frame) in drained {
            let (x, y) = match *r {
                InputRecord::Pointer { x, y, .. } | InputRecord::Wheel { x, y, .. } => (x, y),
                _ => (0.0, 0.0),
            };
            if self.input.len() == INPUT_LOG {
                self.input.pop_front();
            }
            self.input.push_back(Logged {
                kind: h.kind,
                flags: h.flags,
                seq: h.seq,
                t_ms: h.t_ms,
                x,
                y,
                frame: *frame,
            });
        }
    }

    pub(crate) fn frame_start(&mut self, frame: u64, t_main_ms: f64) {
        if self.starts.len() == FRAME_STARTS {
            self.starts.pop_front();
        }
        self.starts.push_back((frame, t_main_ms));
    }
}

fn object(fields: &[(&str, JsValue)]) -> JsValue {
    let o = js_sys::Object::new();
    for (k, v) in fields {
        // Setting a data property on a fresh plain object cannot fail.
        let _ = js_sys::Reflect::set(&o, &JsValue::from_str(k), v);
    }
    o.into()
}

fn array(values: impl IntoIterator<Item = JsValue>) -> JsValue {
    values.into_iter().collect::<js_sys::Array>().into()
}

fn frame_stats() -> JsValue {
    let Some(cb) = control() else {
        return JsValue::NULL;
    };
    let w = |at: u32| cb.word(at).load(Relaxed);
    let frames = w(off::FS_FRAMES);
    let n = frames.min(RECENT);
    let idx = w(off::FS_RECENT_IDX);
    let recent = |base: u32| {
        array((0..n).map(|k| {
            let i = (idx + RECENT - n + k) % RECENT;
            JsValue::from_f64(f64::from(f32::from_bits(w(base + 4 * i))))
        }))
    };
    object(&[
        ("frames", frames.into()),
        ("longFrames", w(off::FS_LONG_FRAMES).into()),
        (
            "hist",
            array((0..HIST_BUCKETS as u32).map(|i| w(off::FS_HIST + 4 * i).into())),
        ),
        ("intervalsMs", recent(off::FS_RECENT_INTERVAL)),
        ("cpuMs", recent(off::FS_RECENT_CPU)),
    ])
}

fn frame_starts() -> JsValue {
    with_renderer(|r| {
        array(r.probe.starts.iter().map(|(frame, t)| {
            object(&[("frame", (*frame as f64).into()), ("tMainMs", (*t).into())])
        }))
    })
    .unwrap_or_else(|| array([]))
}

fn input_log() -> JsValue {
    with_renderer(|r| {
        array(r.probe.input.iter().map(|l| {
            object(&[
                ("kind", l.kind.into()),
                ("flags", l.flags.into()),
                ("seq", l.seq.into()),
                ("tMs", l.t_ms.into()),
                ("x", l.x.into()),
                ("y", l.y.into()),
                ("frame", (l.frame as f64).into()),
            ])
        }))
    })
    .unwrap_or_else(|| array([]))
}

fn threads() -> JsValue {
    let shared = js_sys::Reflect::get(&wasm_bindgen::memory(), &JsValue::from_str("buffer"))
        .map(|b| b.is_instance_of::<js_sys::SharedArrayBuffer>())
        .unwrap_or(false);
    let producer = crate::chunk::pin().map_or(JsValue::NULL, |c| c.producer.into());
    object(&[
        ("sharedMemory", shared.into()),
        ("instancesPublishedBy", producer),
    ])
}

fn method<T: ?Sized + WasmClosure>(o: &js_sys::Object, name: &str, c: Closure<T>) {
    // The closures live as long as the worker (`into_js_value` hands ownership to JS).
    let _ = js_sys::Reflect::set(o, &JsValue::from_str(name), &c.into_js_value());
}

/// Installs `self.__dashProbe` on the render worker.
pub(crate) fn install() {
    let o = js_sys::Object::new();
    method(
        &o,
        "status",
        Closure::<dyn Fn() -> u32>::new(crate::render::render_status),
    );
    method(
        &o,
        "frameStats",
        Closure::<dyn Fn() -> JsValue>::new(frame_stats),
    );
    method(
        &o,
        "frameStarts",
        Closure::<dyn Fn() -> JsValue>::new(frame_starts),
    );
    method(
        &o,
        "inputLog",
        Closure::<dyn Fn() -> JsValue>::new(input_log),
    );
    method(&o, "threads", Closure::<dyn Fn() -> JsValue>::new(threads));
    method(
        &o,
        "pauseInput",
        Closure::<dyn Fn(bool)>::new(|b| {
            with_renderer(|r| r.probe.paused = b);
        }),
    );
    method(
        &o,
        "overflowCount",
        Closure::<dyn Fn() -> u32>::new(|| {
            control().map_or(0, |c| c.word(off::INPUT_OVERFLOW).load(Relaxed))
        }),
    );
    let _ = js_sys::Reflect::set(&js_sys::global(), &JsValue::from_str(PROBE_GLOBAL), &o);
}
