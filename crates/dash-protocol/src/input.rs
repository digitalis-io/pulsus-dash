//! Input ring records (T03 §5.4). Stub.

/// The 16-byte record header.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RecordHeader {
    pub kind: u8,
    pub flags: u8,
    pub size: u16,
    pub seq: u32,
    pub t_ms: f64,
}

/// Pointer record phase: kinds 0x01..=0x04.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PointerPhase {
    Down,
    Move,
    Up,
    Cancel,
}

/// A decoded record (the kinds emitted in #23; any other kind is skipped by size).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InputRecord {
    Pointer {
        phase: PointerPhase,
        x: f32,
        y: f32,
        pointer_id: u32,
        mods: u16,
        buttons: u16,
        button: i8,
        ptype: u8,
        pressure: u8,
        width: u8,
        height: u8,
        tilt_x: i8,
        tilt_y: i8,
    },
    Wheel {
        x: f32,
        y: f32,
        dx: f32,
        dy: f32,
        mods: u16,
        mode: u8,
    },
    Resize {
        css_w: f32,
        css_h: f32,
        dpr: f32,
        device_w: u32,
        device_h: u32,
    },
    Visibility(u8),
    Other {
        kind: u8,
    },
}

/// Wrap marker: one byte; the consumer continues at offset 0.
pub const KIND_WRAP: u8 = 0x00;

/// Why a record could not be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    Short,
    BadSize { size: u16 },
    BadKindSize { kind: u8, size: u16 },
}

/// Decodes one record at the start of `buf`.
pub fn decode(_buf: &[u8]) -> Result<(RecordHeader, InputRecord), DecodeError> {
    Err(DecodeError::Short)
}

/// Encodes a record (tests, replay). Pads to a multiple of 8.
pub fn encode(_h: &RecordHeader, _r: &InputRecord) -> Vec<u8> {
    Vec::new()
}
