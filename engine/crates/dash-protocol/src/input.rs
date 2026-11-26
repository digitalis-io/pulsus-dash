//! The input ring's records (plan #68 C2a1 §3.1; T03 §5.4): a 16-byte header `0 u8 kind · 1 u8
//! flags · 2 u16 size · 4 u32 seq · 8 f64 t_ms`, then the payload; little-endian, every size a
//! multiple of 8, so every record and field is aligned. The adapter writes Resize and Camera only
//! (until #94 adds the raw input records); a Wrap byte at the end of the ring means "continue at the
//! next multiple of `RING_BYTES`" and may be followed by fewer than 16 bytes.
//!
//! The counters (`off::INPUT_HEAD`, `off::INPUT_TAIL`) are free-running `u32` byte counts: occupied
//! = `head.wrapping_sub(tail)`, the physical offset = `counter & (RING_BYTES − 1)`. Seqs are per
//! frame, from 1, never 0, assigned when a record is published.

/// The header.
pub const HEADER_BYTES: u32 = 16;

/// Record kinds (T03 §5.4; `0x24`–`0x26` are reserved).
pub mod rec {
    /// Continue at the next multiple of `RING_BYTES`.
    pub const WRAP: u8 = 0x00;
    pub const RESIZE: u8 = 0x20;
    pub const CAMERA: u8 = 0x23;
    // Test-first stubs (plan #68 C2b §3.1): not wired yet.
    pub const OVERLAY: u8 = 0x00;
    pub const SELECT: u8 = 0x00;
}

pub const RESIZE_BYTES: u32 = 40;
pub const CAMERA_BYTES: u32 = 64;
pub const OVERLAY_BYTES: u32 = 0;
pub const SELECT_BYTES: u32 = 0;

/// Header field offsets.
pub mod header {
    pub const KIND: u32 = 0;
    pub const FLAGS: u32 = 1;
    pub const SIZE: u32 = 2;
    pub const SEQ: u32 = 4;
    pub const T_MS: u32 = 8;
}

/// Resize payload offsets: CSS px and DPR as `f32`, device px as `u32`, then the frame id.
pub mod resize {
    pub const CSS_W: u32 = 16;
    pub const CSS_H: u32 = 20;
    pub const DPR: u32 = 24;
    pub const DEVICE_W: u32 = 28;
    pub const DEVICE_H: u32 = 32;
    pub const FRAME: u32 = 36;
}

/// Camera payload offsets: the frame id, 4 bytes of padding, then `f64`s. NaN value ends = auto;
/// a NaN band = measured.
pub mod camera {
    pub const FRAME: u32 = 16;
    pub const VIEW_LO: u32 = 24;
    pub const VIEW_HI: u32 = 32;
    pub const VALUE_MIN: u32 = 40;
    pub const VALUE_MAX: u32 = 48;
    pub const BAND: u32 = 56;
}

/// Overlay payload offsets (stub).
pub mod overlay {
    pub const FRAME: u32 = 0;
    pub const HOVER: u32 = 0;
    pub const BOX: u32 = 0;
    pub const X: u32 = 0;
    pub const Y: u32 = 0;
    pub const KEY: u32 = 0;
    pub const BOX_X0: u32 = 0;
    pub const BOX_X: u32 = 0;
}

/// Select payload offsets (stub).
pub mod select {
    pub const FRAME: u32 = 0;
    pub const X: u32 = 0;
    pub const Y: u32 = 0;
}

/// The `layout.gen.ts` constants of this module, in order.
pub const ALL: [(&str, u32); 18] = [
    ("REC_WRAP", rec::WRAP as u32),
    ("REC_RESIZE", rec::RESIZE as u32),
    ("REC_CAMERA", rec::CAMERA as u32),
    ("REC_HEADER_BYTES", HEADER_BYTES),
    ("REC_RESIZE_BYTES", RESIZE_BYTES),
    ("REC_CAMERA_BYTES", CAMERA_BYTES),
    ("RESIZE_CSS_W", resize::CSS_W),
    ("RESIZE_CSS_H", resize::CSS_H),
    ("RESIZE_DPR", resize::DPR),
    ("RESIZE_DEVICE_W", resize::DEVICE_W),
    ("RESIZE_DEVICE_H", resize::DEVICE_H),
    ("RESIZE_FRAME", resize::FRAME),
    ("CAMERA_FRAME", camera::FRAME),
    ("CAMERA_VIEW_LO", camera::VIEW_LO),
    ("CAMERA_VIEW_HI", camera::VIEW_HI),
    ("CAMERA_VALUE_MIN", camera::VALUE_MIN),
    ("CAMERA_VALUE_MAX", camera::VALUE_MAX),
    ("CAMERA_BAND", camera::BAND),
];

/// `a` is at or after `b` in seq order (the worker side: valid while they are < 2³¹ apart).
pub fn seq_ge(a: u32, b: u32) -> bool {
    (a.wrapping_sub(b) as i32) >= 0
}
