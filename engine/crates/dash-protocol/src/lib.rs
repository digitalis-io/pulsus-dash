//! The engine's main ↔ worker contract (plan #68 C1 §3.2; T03 §4.3, §9.1, §9.3, T03-005): the
//! control block layout v1, the capability bits and the runtime status codes. The TS adapter's
//! `client/src/engine/wasm/layout.gen.ts` is generated from this crate by [`gen_ts`]
//! (`cargo xtask gen-layout`) and compared with the committed file (`--check`).

/// The control block layout version (T03-005).
pub const LAYOUT_VERSION: u16 = 1;
/// `PDCB` at offset 0.
pub const MAGIC: [u8; 4] = *b"PDCB";
/// The control block: 256 KiB.
pub const CB_BYTES: u32 = 0x40000;
/// Its alignment.
pub const CB_ALIGN: u32 = 64;
/// The input ring's data bytes.
pub const RING_BYTES: u32 = 0x10000;
/// Booting longer than this is Failed (T03 §9.3).
pub const BOOT_TIMEOUT_MS: u32 = 10_000;

pub mod input;

/// One row of the T03 §4.3 table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub name: &'static str,
    pub offset: u32,
    pub size: u32,
}

const fn region(name: &'static str, offset: u32, size: u32) -> Region {
    Region { name, offset, size }
}

/// The T03 §4.3 table, in order (reserved rows included).
pub const REGIONS: [Region; 12] = [
    region("header", 0x00000, 64),
    region("frame_clock", 0x00040, 64),
    region("input_head", 0x00080, 64),
    region("input_tail", 0x000C0, 64),
    region("chords", 0x00100, 512),
    region("reserved_0300", 0x00300, 64),
    region("reserved_0340", 0x00340, 64),
    region("copy", 0x00400, 16 * 1024),
    region("counters", 0x04400, 4 * 1024),
    region("input_data", 0x10000, 64 * 1024),
    region("reserved_20000", 0x20000, 128 * 1024),
    region("end", CB_BYTES, 0),
];

/// Byte offsets from the control block's base (T03 §4.3, layout v1).
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
    /// `u32` [`super::Status`] (T03 §9.3).
    pub const STATUS: u32 = 0x20;
    /// `u64` frames presented.
    pub const FRAME_NO: u32 = 0x40;
    /// `f64` the last present, on the main thread's time origin.
    pub const LAST_PRESENT_MS: u32 = 0x48;
    /// `f32`.
    pub const VSYNC_MS: u32 = 0x50;
    /// `u8` 1 while visible.
    pub const VISIBLE: u32 = 0x54;
    /// `u32` input ring head (main → render).
    pub const INPUT_HEAD: u32 = 0x80;
    /// `u32` input ring tail (render → main).
    pub const INPUT_TAIL: u32 = 0xC0;
    /// `u32` input records dropped (T03-020).
    pub const INPUT_OVERFLOW: u32 = 0xC4;
    /// `u32` 1 while the render worker sleeps (TODO C2a1).
    pub const INPUT_IDLE: u32 = 0;
    /// `u32` input records rejected (TODO C2a1).
    pub const INPUT_BAD: u32 = 0;
    /// The captured-chord table.
    pub const CHORDS: u32 = 0x100;
    /// The copy buffer.
    pub const COPY: u32 = 0x400;
    /// The runtime counters.
    pub const COUNTERS: u32 = 0x4400;
    /// The input ring's data, `RING_BYTES`.
    pub const INPUT_DATA: u32 = 0x10000;

    /// Every offset, in declaration order (the `OFF_` exports of `layout.gen.ts`).
    pub const ALL: [(&str, u32); 19] = [
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
        ("INPUT_IDLE", INPUT_IDLE),
        ("CHORDS", CHORDS),
        ("COPY", COPY),
        ("COUNTERS", COUNTERS),
        ("INPUT_BAD", INPUT_BAD),
        ("INPUT_DATA", INPUT_DATA),
    ];
}

/// Capability bits (T03 §9.1), probed on the main thread; the render worker ORs in `WEBGL2`.
pub mod caps {
    pub const ISOLATED: u32 = 1 << 0;
    pub const OFFSCREEN: u32 = 1 << 1;
    pub const WEBGPU: u32 = 1 << 2;
    pub const WEBGL2: u32 = 1 << 3;
    pub const WAIT_ASYNC: u32 = 1 << 4;
    pub const DPCB: u32 = 1 << 5;

    /// Every bit, in declaration order (the `CAP_` exports of `layout.gen.ts`).
    pub const ALL: [(&str, u32); 6] = [
        ("ISOLATED", ISOLATED),
        ("OFFSCREEN", OFFSCREEN),
        ("WEBGPU", WEBGPU),
        ("WEBGL2", WEBGL2),
        ("WAIT_ASYNC", WAIT_ASYNC),
        ("DPCB", DPCB),
    ];
}

/// The runtime status (T03 §9.3): the control block's `STATUS` word and `<html data-dash-status>`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Status {
    Booting = 0,
    TierT1 = 1,
    TierT2 = 2,
    Static = 3,
    Failed = 4,
    Stale = 5,
}

impl Status {
    pub const ALL: [Status; 6] = [
        Status::Booting,
        Status::TierT1,
        Status::TierT2,
        Status::Static,
        Status::Failed,
        Status::Stale,
    ];

    /// The status with code `v`.
    pub fn from_u32(v: u32) -> Option<Self> {
        Self::ALL.into_iter().find(|s| *s as u32 == v)
    }

    /// The `STATUS_<name>` suffix in `layout.gen.ts`.
    pub fn ts_name(self) -> &'static str {
        match self {
            Status::Booting => "BOOTING",
            Status::TierT1 => "TIER_T1",
            Status::TierT2 => "TIER_T2",
            Status::Static => "STATIC",
            Status::Failed => "FAILED",
            Status::Stale => "STALE",
        }
    }
}

/// The committed file `gen_ts` writes, relative to the repository root.
pub const GEN_TS_PATH: &str = "client/src/engine/wasm/layout.gen.ts";

/// The exact text of `client/src/engine/wasm/layout.gen.ts`: a header comment, then one
/// `export const NAME = value;` per line (`LAYOUT_VERSION`, `CB_BYTES`, `CB_ALIGN`, `RING_BYTES`,
/// `BOOT_TIMEOUT_MS`, `OFF_*`, `CAP_*`, `STATUS_*`). Decimal values, ASCII, `\n` line ends.
pub fn gen_ts() -> String {
    let mut s = String::from(
        "// Generated by `cargo xtask gen-layout` from engine/crates/dash-protocol. Do not edit.\n",
    );
    let mut line = |name: &str, value: u32| {
        s.push_str("export const ");
        s.push_str(name);
        s.push_str(" = ");
        s.push_str(&value.to_string());
        s.push_str(";\n");
    };
    line("LAYOUT_VERSION", u32::from(LAYOUT_VERSION));
    line("CB_BYTES", CB_BYTES);
    line("CB_ALIGN", CB_ALIGN);
    line("RING_BYTES", RING_BYTES);
    line("BOOT_TIMEOUT_MS", BOOT_TIMEOUT_MS);
    for (name, v) in off::ALL {
        line(&format!("OFF_{name}"), v);
    }
    for (name, v) in caps::ALL {
        line(&format!("CAP_{name}"), v);
    }
    for st in Status::ALL {
        line(&format!("STATUS_{}", st.ts_name()), st as u32);
    }
    s
}
