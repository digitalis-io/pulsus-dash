//! Control block layout v1 (T03 §4.3, T03-005).
//!
//! The render worker allocates one `CB_SIZE` block, `CB_ALIGN`-aligned, and returns its address
//! in its first status message. The shim reaches it through views of the shared memory, using
//! the offsets of `web/shim/layout.gen.js`, which is generated from this module by
//! [`render_js`] (`cargo xtask gen`) and diffed by `ci:shim-lint` and `ci:dep-audit`.

use crate::status::{RETRY_T2, RuntimeStatus};

pub const LAYOUT_VERSION: u16 = 1;
pub const MAGIC: [u8; 4] = *b"PDCB";
/// 256 KiB.
pub const CB_SIZE: u32 = 0x40000;
pub const CB_ALIGN: u32 = 64;
/// Bytes of each ring's data region.
pub const RING_BYTES: u32 = 0x10000;
/// `boot.js` shows Failed if the status is still Booting after this long.
pub const BOOT_TIMEOUT_MS: u32 = 10_000;

/// One row of the T03 §4.3 table, in table order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub name: &'static str,
    pub offset: u32,
    pub size: u32,
}

const fn region(name: &'static str, offset: u32, size: u32) -> Region {
    Region { name, offset, size }
}

pub const REGIONS: [Region; 12] = [
    region("header", 0x00000, 64),
    region("frame_clock", 0x00040, 64),
    region("input_head", 0x00080, 64),
    region("input_tail", 0x000C0, 64),
    region("chords", 0x00100, 512),
    region("ui_core", 0x00300, 64),
    region("core_ui", 0x00340, 64),
    region("copy", 0x00400, 16384),
    region("counters", 0x04400, 4096),
    region("input_data", 0x10000, 65536),
    region("ui_core_data", 0x20000, 65536),
    region("core_ui_data", 0x30000, 65536),
];

/// Byte offsets from the control-block base.
pub mod off {
    /// `[u8; 4]` = `MAGIC`.
    pub const MAGIC: u32 = 0x00;
    /// `u16`.
    pub const LAYOUT_VERSION: u32 = 0x04;
    /// `u32` capability bits ([`super::caps`]).
    pub const CAPS: u32 = 0x08;
    /// `u32`.
    pub const BOOT_EPOCH: u32 = 0x0C;
    /// `[u8; 16]`.
    pub const BUILD_ID: u32 = 0x10;
    /// `u32` [`crate::status::RuntimeStatus`] code (T03 §9.3).
    pub const STATUS: u32 = 0x20;
    /// `u64` frames presented.
    pub const FRAME_NO: u32 = 0x40;
    /// `f64` time of the last present, on the main thread's time origin.
    pub const LAST_PRESENT_MS: u32 = 0x48;
    /// `f32`.
    pub const VSYNC_MS: u32 = 0x50;
    /// `u8` 1 while the page is visible.
    pub const VISIBLE: u32 = 0x54;
    /// `u32` input ring head (free-running byte counter; shim → render).
    pub const INPUT_HEAD: u32 = 0x80;
    /// `u32` input ring tail (render → shim).
    pub const INPUT_TAIL: u32 = 0xC0;
    /// `u32` input records dropped (T03-020).
    pub const INPUT_OVERFLOW: u32 = 0xC4;
    /// Input ring data, `RING_BYTES`.
    pub const INPUT_DATA: u32 = 0x10000;
    /// `u32` frame intervals recorded.
    pub const FS_FRAMES: u32 = 0x4400;
    /// `u32` next write index (mod 256) of the recent arrays.
    pub const FS_RECENT_IDX: u32 = 0x4404;
    /// `u32` intervals > 50 ms.
    pub const FS_LONG_FRAMES: u32 = 0x4408;
    /// `u32` input ring resyncs after an undecodable record.
    pub const FS_RING_CORRUPT: u32 = 0x440C;
    /// `[u32; 64]`: bucket i = [0.5 i, 0.5 (i + 1)) ms; 63 = ≥ 31.5 ms.
    pub const FS_HIST: u32 = 0x4410;
    /// `[f32; 256]` recent frame intervals (ms).
    pub const FS_RECENT_INTERVAL: u32 = 0x4510;
    /// `[f32; 256]` recent render CPU time per frame (ms).
    pub const FS_RECENT_CPU: u32 = 0x4910;

    /// Every offset, in declaration order (the `OFF_` exports of `layout.gen.js`).
    pub const ALL: [(&str, u32); 21] = [
        ("MAGIC", MAGIC),
        ("LAYOUT_VERSION", LAYOUT_VERSION),
        ("CAPS", CAPS),
        ("BOOT_EPOCH", BOOT_EPOCH),
        ("BUILD_ID", BUILD_ID),
        ("STATUS", STATUS),
        ("FRAME_NO", FRAME_NO),
        ("LAST_PRESENT_MS", LAST_PRESENT_MS),
        ("VSYNC_MS", VSYNC_MS),
        ("VISIBLE", VISIBLE),
        ("INPUT_HEAD", INPUT_HEAD),
        ("INPUT_TAIL", INPUT_TAIL),
        ("INPUT_OVERFLOW", INPUT_OVERFLOW),
        ("INPUT_DATA", INPUT_DATA),
        ("FS_FRAMES", FS_FRAMES),
        ("FS_RECENT_IDX", FS_RECENT_IDX),
        ("FS_LONG_FRAMES", FS_LONG_FRAMES),
        ("FS_RING_CORRUPT", FS_RING_CORRUPT),
        ("FS_HIST", FS_HIST),
        ("FS_RECENT_INTERVAL", FS_RECENT_INTERVAL),
        ("FS_RECENT_CPU", FS_RECENT_CPU),
    ];
}

/// Capability bits (T03 §9.1), probed by `boot.js`; render ORs in `WEBGL2`.
pub mod caps {
    pub const ISOLATED: u32 = 1 << 0;
    pub const OFFSCREEN: u32 = 1 << 1;
    pub const WEBGPU: u32 = 1 << 2;
    pub const WEBGL2: u32 = 1 << 3;
    pub const WAIT_ASYNC: u32 = 1 << 4;
    pub const DPCB: u32 = 1 << 5;

    /// Every bit, in declaration order (the `CAP_` exports of `layout.gen.js`).
    pub const ALL: [(&str, u32); 6] = [
        ("ISOLATED", ISOLATED),
        ("OFFSCREEN", OFFSCREEN),
        ("WEBGPU", WEBGPU),
        ("WEBGL2", WEBGL2),
        ("WAIT_ASYNC", WAIT_ASYNC),
        ("DPCB", DPCB),
    ];
}

const JS_HEADER: &str = "// Generated by `cargo xtask gen` from dash-protocol. Do not edit.\n";

/// The exact text of `web/shim/layout.gen.js`: the header comment, then one
/// `export const NAME = value;` per line: `LAYOUT_VERSION`, `CB_SIZE`, `RING_BYTES`,
/// `BOOT_TIMEOUT_MS`, `RETRY_T2`, `OFF_<name>` for every [`off`] constant, `CAP_<name>` for every
/// [`caps`] bit and `STATUS_<name>` for every [`RuntimeStatus`]. Decimal values, ASCII, `\n`.
pub fn render_js() -> String {
    let mut s = String::from(JS_HEADER);
    let mut line = |name: &str, value: u32| {
        s.push_str("export const ");
        s.push_str(name);
        s.push_str(" = ");
        s.push_str(&value.to_string());
        s.push_str(";\n");
    };
    line("LAYOUT_VERSION", u32::from(LAYOUT_VERSION));
    line("CB_SIZE", CB_SIZE);
    line("RING_BYTES", RING_BYTES);
    line("BOOT_TIMEOUT_MS", BOOT_TIMEOUT_MS);
    line("RETRY_T2", RETRY_T2);
    for (name, v) in off::ALL {
        line(&format!("OFF_{name}"), v);
    }
    for (name, v) in caps::ALL {
        line(&format!("CAP_{name}"), v);
    }
    for st in RuntimeStatus::ALL {
        line(&format!("STATUS_{}", st.js_name()), st as u32);
    }
    s
}
