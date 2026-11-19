//! Input ring records (T03 §5.4): a 16-byte header, then a kind-specific payload, padded to a
//! multiple of 8 bytes; little-endian. #23 emits pointer, wheel, resize and visibility records;
//! any other kind decodes as [`InputRecord::Other`] and is skipped by its size.

/// The 16-byte record header.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RecordHeader {
    pub kind: u8,
    /// bit0 coalesced, bit1 predicted, bit2 synthetic, bit3 overflowed-before.
    pub flags: u8,
    /// Record size in bytes, header included.
    pub size: u16,
    /// Monotonic per tab.
    pub seq: u32,
    /// `event.timeStamp` on the main thread's time origin.
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

/// A decoded record.
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
    /// 0x05.
    Wheel {
        x: f32,
        y: f32,
        dx: f32,
        dy: f32,
        mods: u16,
        mode: u8,
    },
    /// 0x20.
    Resize {
        css_w: f32,
        css_h: f32,
        dpr: f32,
        device_w: u32,
        device_h: u32,
    },
    /// 0x21: 0 blur, 1 focus, 2 hidden, 3 visible.
    Visibility(u8),
    /// Any other kind: skipped by size.
    Other { kind: u8 },
}

/// Wrap marker: one byte; the consumer continues at offset 0.
pub const KIND_WRAP: u8 = 0x00;

pub const KIND_POINTER_DOWN: u8 = 0x01;
pub const KIND_POINTER_MOVE: u8 = 0x02;
pub const KIND_POINTER_UP: u8 = 0x03;
pub const KIND_POINTER_CANCEL: u8 = 0x04;
pub const KIND_WHEEL: u8 = 0x05;
pub const KIND_RESIZE: u8 = 0x20;
pub const KIND_VISIBILITY: u8 = 0x21;

/// The header size; also the minimum record size.
pub const HEADER_BYTES: usize = 16;

/// Why a record could not be decoded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecodeError {
    /// Fewer than 16 bytes.
    Short,
    /// size < 16, size % 8 ≠ 0, or size > the bytes available.
    BadSize { size: u16 },
    /// A known kind with a size other than its T03 §5.4 size.
    BadKindSize { kind: u8, size: u16 },
}

/// The T03 §5.4 size of a kind this crate decodes, if known.
fn kind_size(kind: u8) -> Option<u16> {
    match kind {
        KIND_POINTER_DOWN..=KIND_WHEEL | KIND_RESIZE => Some(40),
        KIND_VISIBILITY => Some(24),
        _ => None,
    }
}

/// Little-endian reads from a slice whose length was checked by the caller.
struct Le<'a>(&'a [u8]);

impl Le<'_> {
    fn bytes<const N: usize>(&self, at: usize) -> [u8; N] {
        let mut out = [0u8; N];
        if let Some(src) = self.0.get(at..at + N) {
            out.copy_from_slice(src);
        }
        out
    }
    fn u8(&self, at: usize) -> u8 {
        self.0.get(at).copied().unwrap_or(0)
    }
    fn i8(&self, at: usize) -> i8 {
        i8::from_le_bytes([self.u8(at)])
    }
    fn u16(&self, at: usize) -> u16 {
        u16::from_le_bytes(self.bytes(at))
    }
    fn u32(&self, at: usize) -> u32 {
        u32::from_le_bytes(self.bytes(at))
    }
    fn f32(&self, at: usize) -> f32 {
        f32::from_le_bytes(self.bytes(at))
    }
    fn f64(&self, at: usize) -> f64 {
        f64::from_le_bytes(self.bytes(at))
    }
}

/// Decodes one record at the start of `buf` (little-endian, offsets as T03 §5.4).
pub fn decode(buf: &[u8]) -> Result<(RecordHeader, InputRecord), DecodeError> {
    if buf.len() < HEADER_BYTES {
        return Err(DecodeError::Short);
    }
    let le = Le(buf);
    let kind = le.u8(0);
    let size = le.u16(2);
    if usize::from(size) < HEADER_BYTES || size % 8 != 0 || usize::from(size) > buf.len() {
        return Err(DecodeError::BadSize { size });
    }
    if kind_size(kind).is_some_and(|want| want != size) {
        return Err(DecodeError::BadKindSize { kind, size });
    }
    let h = RecordHeader {
        kind,
        flags: le.u8(1),
        size,
        seq: le.u32(4),
        t_ms: le.f64(8),
    };
    let pointer = |phase| InputRecord::Pointer {
        phase,
        x: le.f32(16),
        y: le.f32(20),
        pointer_id: le.u32(24),
        mods: le.u16(28),
        buttons: le.u16(30),
        button: le.i8(32),
        ptype: le.u8(33),
        pressure: le.u8(34),
        width: le.u8(36),
        height: le.u8(37),
        tilt_x: le.i8(38),
        tilt_y: le.i8(39),
    };
    let r = match kind {
        KIND_POINTER_DOWN => pointer(PointerPhase::Down),
        KIND_POINTER_MOVE => pointer(PointerPhase::Move),
        KIND_POINTER_UP => pointer(PointerPhase::Up),
        KIND_POINTER_CANCEL => pointer(PointerPhase::Cancel),
        KIND_WHEEL => InputRecord::Wheel {
            x: le.f32(16),
            y: le.f32(20),
            dx: le.f32(24),
            dy: le.f32(28),
            mods: le.u16(32),
            mode: le.u8(34),
        },
        KIND_RESIZE => InputRecord::Resize {
            css_w: le.f32(16),
            css_h: le.f32(20),
            dpr: le.f32(24),
            device_w: le.u32(28),
            device_h: le.u32(32),
        },
        KIND_VISIBILITY => InputRecord::Visibility(le.u8(16)),
        kind => InputRecord::Other { kind },
    };
    Ok((h, r))
}

/// Encodes a record (tests, replay). The header's `kind` and `size` follow the record (an
/// `Other` record keeps `h.kind` and is header-only); padded to a multiple of 8.
pub fn encode(h: &RecordHeader, r: &InputRecord) -> Vec<u8> {
    let kind = match r {
        InputRecord::Pointer { phase, .. } => match phase {
            PointerPhase::Down => KIND_POINTER_DOWN,
            PointerPhase::Move => KIND_POINTER_MOVE,
            PointerPhase::Up => KIND_POINTER_UP,
            PointerPhase::Cancel => KIND_POINTER_CANCEL,
        },
        InputRecord::Wheel { .. } => KIND_WHEEL,
        InputRecord::Resize { .. } => KIND_RESIZE,
        InputRecord::Visibility(_) => KIND_VISIBILITY,
        InputRecord::Other { kind } => *kind,
    };
    let size = kind_size(kind).unwrap_or(HEADER_BYTES as u16);
    let mut b = Vec::with_capacity(usize::from(size));
    b.push(kind);
    b.push(h.flags);
    b.extend_from_slice(&size.to_le_bytes());
    b.extend_from_slice(&h.seq.to_le_bytes());
    b.extend_from_slice(&h.t_ms.to_le_bytes());
    match *r {
        InputRecord::Pointer {
            x,
            y,
            pointer_id,
            mods,
            buttons,
            button,
            ptype,
            pressure,
            width,
            height,
            tilt_x,
            tilt_y,
            ..
        } => {
            b.extend_from_slice(&x.to_le_bytes());
            b.extend_from_slice(&y.to_le_bytes());
            b.extend_from_slice(&pointer_id.to_le_bytes());
            b.extend_from_slice(&mods.to_le_bytes());
            b.extend_from_slice(&buttons.to_le_bytes());
            b.extend_from_slice(&button.to_le_bytes());
            b.extend_from_slice(&[ptype, pressure, 0, width, height]);
            b.extend_from_slice(&tilt_x.to_le_bytes());
            b.extend_from_slice(&tilt_y.to_le_bytes());
        }
        InputRecord::Wheel {
            x,
            y,
            dx,
            dy,
            mods,
            mode,
        } => {
            for v in [x, y, dx, dy] {
                b.extend_from_slice(&v.to_le_bytes());
            }
            b.extend_from_slice(&mods.to_le_bytes());
            b.push(mode);
        }
        InputRecord::Resize {
            css_w,
            css_h,
            dpr,
            device_w,
            device_h,
        } => {
            for v in [css_w, css_h, dpr] {
                b.extend_from_slice(&v.to_le_bytes());
            }
            b.extend_from_slice(&device_w.to_le_bytes());
            b.extend_from_slice(&device_h.to_le_bytes());
        }
        InputRecord::Visibility(v) => b.push(v),
        InputRecord::Other { .. } => {}
    }
    b.resize(usize::from(size), 0);
    b
}
