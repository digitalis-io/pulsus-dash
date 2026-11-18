//! Control block layout v1 (T03 §4.3, T03-005). Stub: values are filled in by the implementation.

pub const LAYOUT_VERSION: u16 = 0;
pub const MAGIC: [u8; 4] = [0; 4];
pub const CB_SIZE: u32 = 0;
pub const CB_ALIGN: u32 = 0;
pub const RING_BYTES: u32 = 0;
pub const BOOT_TIMEOUT_MS: u32 = 0;

/// One row of the T03 §4.3 table, in table order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Region {
    pub name: &'static str,
    pub offset: u32,
    pub size: u32,
}

const Z: Region = Region {
    name: "",
    offset: 0,
    size: 0,
};
pub const REGIONS: [Region; 12] = [Z; 12];

/// Byte offsets from the control-block base.
pub mod off {
    pub const MAGIC: u32 = 0;
    pub const LAYOUT_VERSION: u32 = 0;
    pub const CAPS: u32 = 0;
    pub const BOOT_EPOCH: u32 = 0;
    pub const BUILD_ID: u32 = 0;
    pub const STATUS: u32 = 0;
    pub const FRAME_NO: u32 = 0;
    pub const LAST_PRESENT_MS: u32 = 0;
    pub const VSYNC_MS: u32 = 0;
    pub const VISIBLE: u32 = 0;
    pub const INPUT_HEAD: u32 = 0;
    pub const INPUT_TAIL: u32 = 0;
    pub const INPUT_OVERFLOW: u32 = 0;
    pub const INPUT_DATA: u32 = 0;
    pub const FS_FRAMES: u32 = 0;
    pub const FS_RECENT_IDX: u32 = 0;
    pub const FS_LONG_FRAMES: u32 = 0;
    pub const FS_RING_CORRUPT: u32 = 0;
    pub const FS_HIST: u32 = 0;
    pub const FS_RECENT_INTERVAL: u32 = 0;
    pub const FS_RECENT_CPU: u32 = 0;
}

/// Capability bits (T03 §9.1).
pub mod caps {
    pub const ISOLATED: u32 = 0;
    pub const OFFSCREEN: u32 = 0;
    pub const WEBGPU: u32 = 0;
    pub const WEBGL2: u32 = 0;
    pub const WAIT_ASYNC: u32 = 0;
    pub const DPCB: u32 = 0;
}

/// The exact text of `web/shim/layout.gen.js`.
pub fn render_js() -> String {
    String::new()
}
