//! The input ring's records (TODO C2a1: stub).

pub const HEADER_BYTES: u32 = 0;

pub mod rec {
    pub const WRAP: u8 = 0xFF;
    pub const RESIZE: u8 = 0;
    pub const CAMERA: u8 = 0;
}

pub const RESIZE_BYTES: u32 = 0;
pub const CAMERA_BYTES: u32 = 0;

pub fn seq_ge(_a: u32, _b: u32) -> bool {
    false
}

pub mod header {
    pub const KIND: u32 = 0;
    pub const FLAGS: u32 = 0;
    pub const SIZE: u32 = 0;
    pub const SEQ: u32 = 0;
    pub const T_MS: u32 = 0;
}

pub mod resize {
    pub const CSS_W: u32 = 0;
    pub const CSS_H: u32 = 0;
    pub const DPR: u32 = 0;
    pub const DEVICE_W: u32 = 0;
    pub const DEVICE_H: u32 = 0;
    pub const FRAME: u32 = 0;
}

pub mod camera {
    pub const FRAME: u32 = 0;
    pub const VIEW_LO: u32 = 0;
    pub const VIEW_HI: u32 = 0;
    pub const VALUE_MIN: u32 = 0;
    pub const VALUE_MAX: u32 = 0;
    pub const BAND: u32 = 0;
}

pub const ALL: [(&str, u32); 0] = [];
