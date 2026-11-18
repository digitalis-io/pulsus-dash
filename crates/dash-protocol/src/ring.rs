//! The SPSC input ring (T03-006). Stub.

use crate::input::{InputRecord, RecordHeader};

/// One SPSC ring in a control block.
#[derive(Debug)]
pub struct RingView {
    base: *mut u8,
    head_off: u32,
    tail_off: u32,
    data_off: u32,
}

/// The ring has no room for the record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RingFull;

impl RingView {
    /// # Safety
    /// `base` is 64-byte aligned, valid for `CB_SIZE` bytes for `'static`, and only one producer
    /// and one consumer use this ring.
    pub unsafe fn input(base: *mut u8) -> Self {
        RingView {
            base,
            head_off: 0,
            tail_off: 0,
            data_off: 0,
        }
    }

    pub fn drain(&mut self, _f: &mut dyn FnMut(RecordHeader, InputRecord)) -> u32 {
        let _ = (self.base, self.head_off, self.tail_off, self.data_off);
        0
    }

    pub fn push(&mut self, _rec: &[u8]) -> Result<(), RingFull> {
        Err(RingFull)
    }
}
