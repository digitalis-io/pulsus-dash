//! The input ring's consumer (plan #68 C2a1 §3.2, §4.2; T03 §5.4, T03-006, T03-019): the render
//! worker reads the records the adapter published, `[tail, head)`, at the start of each tick, and
//! decides whether it may sleep. Target-independent: the words are the control block's
//! (`web::control::Control`) on wasm32 and plain atomics in the tests.
//!
//! | Step | Behaviour |
//! |---|---|
//! | `drain` | head with Acquire, records in order, the wrap marker followed; tail := head (Release) also after a bad record, so one bad batch is skipped whole |
//! | bad record | size < 16, not a multiple of 8, past head or the end of the ring, the wrong size for its kind, or an unknown kind |
//! | `drain_batch` | the single-thread engine's input batch (plan #68 C2d2 §3.2): the same records from a byte slice, the same rejections |
//! | `before_sleep` | idle := 1, then head ≠ tail → idle := 0, tick again; else sleep until the adapter's `input` message (all SeqCst) |
//!
//! The producer stores head then compare-exchanges idle 1 → 0; the consumer stores idle = 1 then
//! loads head. With sequentially consistent ordering on both sides, the producer's exchange sees 1
//! (it wakes the worker) or the consumer's load sees the new head (it ticks again), or both: a
//! publish is never left unread while the worker sleeps.

use std::sync::atomic::Ordering;

use dash_protocol::input::{
    CAMERA_BYTES, HEADER_BYTES, OVERLAY_BYTES, RESIZE_BYTES, SELECT_BYTES, camera, header, overlay,
    rec, resize, select,
};
use dash_protocol::{RING_BYTES, off};
use serde_json::json;

/// The control block's `u32` words, by byte offset from its base.
pub trait Words {
    fn load(&self, off: u32, o: Ordering) -> u32;
    fn store(&self, off: u32, v: u32, o: Ordering);
    fn swap(&self, off: u32, v: u32, o: Ordering) -> u32;
}

/// A decoded payload.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Record {
    Resize {
        frame: u32,
        css_w: f32,
        css_h: f32,
        dpr: f32,
        device_w: u32,
        device_h: u32,
    },
    /// NaN value ends = auto; a NaN band = measured (validated by `CameraIn::from_record`).
    Camera {
        frame: u32,
        view: (f64, f64),
        value: (f64, f64),
        band: f64,
    },
    /// The hover and the box band (plan #68 C2b §3.1): hover 0 none, 1 pointer (x, y CSS px), 2
    /// key (`key` index); box 0, 1 (`box_x0`, `box_x`). Validated by `Frames::apply`.
    Overlay {
        frame: u32,
        hover: u8,
        boxed: u8,
        x: f64,
        y: f64,
        key: u32,
        box_x0: f64,
        box_x: f64,
    },
    /// A click at (x, y) CSS px (plan #68 C2b §3.1).
    Select { frame: u32, x: f64, y: f64 },
}

/// One record: its per-frame seq, the adapter's `performance.now()` at enqueue, the payload.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Decoded {
    pub seq: u32,
    pub t_ms: f64,
    pub rec: Record,
}

/// A record the decoder rejected, at this counter value; the rest of the batch was skipped.
#[derive(Debug, PartialEq, thiserror::Error)]
#[error("input record at {at}")]
pub struct Bad {
    pub at: u32,
}

/// Reads one ring word at physical offset `phys`.
fn word(w: &impl Words, phys: u32) -> u32 {
    w.load(off::INPUT_DATA + phys, Ordering::Relaxed)
}

/// One little-endian `u32` of a batch at byte `at` (0 past its end: the caller checked the size).
fn batch_word(b: &[u8], at: u32) -> u32 {
    let at = at as usize;
    b.get(at..at + 4)
        .and_then(|w| <[u8; 4]>::try_from(w).ok())
        .map_or(0, u32::from_le_bytes)
}

/// The record at offset `at` read through `word` (the ring's words or a batch's bytes), `size`
/// bytes, kind `kind`; `None` when the size is not the kind's or the kind is unknown.
fn decode(word: impl Fn(u32) -> u32, at: u32, kind: u8, size: u32) -> Option<Decoded> {
    let f64_at = |p: u32| f64::from_bits(u64::from(word(p)) | (u64::from(word(p + 4)) << 32));
    let f32_at = |p: u32| f32::from_bits(word(p));
    let seq = word(at + header::SEQ);
    let t_ms = f64_at(at + header::T_MS);
    let rec = match (kind, size) {
        (rec::RESIZE, RESIZE_BYTES) => Record::Resize {
            frame: word(at + resize::FRAME),
            css_w: f32_at(at + resize::CSS_W),
            css_h: f32_at(at + resize::CSS_H),
            dpr: f32_at(at + resize::DPR),
            device_w: word(at + resize::DEVICE_W),
            device_h: word(at + resize::DEVICE_H),
        },
        (rec::CAMERA, CAMERA_BYTES) => Record::Camera {
            frame: word(at + camera::FRAME),
            view: (f64_at(at + camera::VIEW_LO), f64_at(at + camera::VIEW_HI)),
            value: (
                f64_at(at + camera::VALUE_MIN),
                f64_at(at + camera::VALUE_MAX),
            ),
            band: f64_at(at + camera::BAND),
        },
        (rec::OVERLAY, OVERLAY_BYTES) => {
            // HOVER and BOX are bytes 0 and 1 of the word at HOVER.
            let modes = word(at + overlay::HOVER);
            Record::Overlay {
                frame: word(at + overlay::FRAME),
                hover: (modes & 0xFF) as u8,
                boxed: ((modes >> (8 * (overlay::BOX - overlay::HOVER))) & 0xFF) as u8,
                x: f64_at(at + overlay::X),
                y: f64_at(at + overlay::Y),
                key: word(at + overlay::KEY),
                box_x0: f64_at(at + overlay::BOX_X0),
                box_x: f64_at(at + overlay::BOX_X),
            }
        }
        (rec::SELECT, SELECT_BYTES) => Record::Select {
            frame: word(at + select::FRAME),
            x: f64_at(at + select::X),
            y: f64_at(at + select::Y),
        },
        _ => return None,
    };
    Some(Decoded { seq, t_ms, rec })
}

/// Reads [tail, head) (head Acquire) into `out`, in order, and stores tail = head (Release), also
/// on `Err`: a bad record and the rest of the batch are skipped.
pub fn drain(w: &impl Words, out: &mut Vec<Decoded>) -> Result<(), Bad> {
    let head = w.load(off::INPUT_HEAD, Ordering::Acquire);
    let mut pos = w.load(off::INPUT_TAIL, Ordering::Relaxed);
    let result = loop {
        let left = head.wrapping_sub(pos);
        if left == 0 {
            break Ok(());
        }
        if left > RING_BYTES {
            break Err(Bad { at: pos });
        }
        let phys = pos & (RING_BYTES - 1);
        let w0 = word(w, phys);
        let kind = (w0 & 0xFF) as u8;
        if kind == rec::WRAP {
            let gap = RING_BYTES - phys;
            if gap > left {
                break Err(Bad { at: pos });
            }
            pos = pos.wrapping_add(gap);
            continue;
        }
        let size = w0 >> (8 * header::SIZE);
        if size < HEADER_BYTES || !size.is_multiple_of(8) || size > left || phys + size > RING_BYTES
        {
            break Err(Bad { at: pos });
        }
        match decode(|p| word(w, p), phys, kind, size) {
            Some(d) => out.push(d),
            None => break Err(Bad { at: pos }),
        }
        pos = pos.wrapping_add(size);
    };
    w.store(off::INPUT_TAIL, head, Ordering::Release);
    result
}

/// One input batch of the single-thread engine (plan #68 C2d2 §3.2): the records of `bytes`, in
/// the ring's format (the adapter's `BatchRing` writes the `InputRing`'s record bytes), appended to
/// `out` in order. A wrap marker is skipped by its size (a batch has none, but a ring image does).
/// A bad record (as in [`drain`]: size < 16, not a multiple of 8, past the end, the wrong size for
/// its kind, or an unknown kind) is `Err` at its byte offset; the rest of the batch is skipped.
pub fn drain_batch(bytes: &[u8], out: &mut Vec<Decoded>) -> Result<(), Bad> {
    let len = u32::try_from(bytes.len()).map_err(|_| Bad { at: 0 })?;
    let mut at = 0u32;
    while at < len {
        let w0 = batch_word(bytes, at);
        let kind = (w0 & 0xFF) as u8;
        let size = w0 >> (8 * header::SIZE);
        let left = len - at;
        if kind == rec::WRAP {
            if size == 0 || size > left || !size.is_multiple_of(8) {
                return Err(Bad { at });
            }
            at += size;
            continue;
        }
        if size < HEADER_BYTES || !size.is_multiple_of(8) || size > left {
            return Err(Bad { at });
        }
        match decode(|p| batch_word(bytes, p), at, kind, size) {
            Some(d) => out.push(d),
            None => return Err(Bad { at }),
        }
        at += size;
    }
    Ok(())
}

/// Called when the worker has nothing else to do: idle := 1 (SeqCst); if head ≠ tail (SeqCst)
/// then idle := 0 and true (tick again), else false (sleep until the `input` message).
pub fn before_sleep(w: &impl Words) -> bool {
    w.store(off::INPUT_IDLE, 1, Ordering::SeqCst);
    let head = w.load(off::INPUT_HEAD, Ordering::SeqCst);
    let tail = w.load(off::INPUT_TAIL, Ordering::SeqCst);
    if head != tail {
        w.store(off::INPUT_IDLE, 0, Ordering::SeqCst);
        return true;
    }
    false
}

/// The probe build's log entry of a decoded record, in the adapter's `InputRec` shape (`ring.ts`):
/// `{seq, kind, frame, tMs, f}` with `f` the payload in table order, `f32`s widened exactly and
/// NaN as null, so it compares equal to the adapter's log.
pub fn log_json(d: &Decoded) -> serde_json::Value {
    let (kind, frame, f) = match d.rec {
        Record::Resize {
            frame,
            css_w,
            css_h,
            dpr,
            device_w,
            device_h,
        } => (
            rec::RESIZE,
            frame,
            json!([
                f64::from(css_w),
                f64::from(css_h),
                f64::from(dpr),
                device_w,
                device_h,
                frame
            ]),
        ),
        Record::Camera {
            frame,
            view,
            value,
            band,
        } => (
            rec::CAMERA,
            frame,
            json!([frame, view.0, view.1, value.0, value.1, band]),
        ),
        Record::Overlay {
            frame,
            hover,
            boxed,
            x,
            y,
            key,
            box_x0,
            box_x,
        } => (
            rec::OVERLAY,
            frame,
            json!([frame, hover, boxed, x, y, key, box_x0, box_x]),
        ),
        Record::Select { frame, x, y } => (rec::SELECT, frame, json!([frame, x, y])),
    };
    json!({"seq": d.seq, "kind": kind, "frame": frame, "tMs": d.t_ms, "f": f})
}
