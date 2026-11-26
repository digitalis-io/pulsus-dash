//! The control block (T03 §4.3, layout v1): 256 KiB, 64-byte aligned, in the shared memory; the
//! render worker writes the header and the frame clock, and reads the input ring (plan #68 C2a1:
//! [`Words`] for `input::drain` and `input::before_sleep`).

use std::sync::atomic::{AtomicU32, Ordering};

use dash_protocol::{CB_ALIGN, CB_BYTES, LAYOUT_VERSION, MAGIC, Status, off};

use crate::input::Words;

/// One 64-byte line of the block.
#[repr(C, align(64))]
#[derive(Debug, Default)]
struct Line([AtomicU32; 16]);

const _: () = assert!(std::mem::size_of::<Line>() as u32 == CB_ALIGN);

/// The render worker's control block, allocated once and never freed.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Control {
    lines: &'static [Line],
}

impl Control {
    pub(crate) fn alloc() -> Self {
        let lines: Vec<Line> = (0..CB_BYTES / CB_ALIGN).map(|_| Line::default()).collect();
        Self {
            lines: Box::leak(lines.into_boxed_slice()),
        }
    }

    /// The block's address in the shared memory.
    pub(crate) fn addr(&self) -> u32 {
        self.lines.as_ptr() as usize as u32
    }

    fn word(&self, offset: u32) -> Option<&AtomicU32> {
        let line = self.lines.get((offset / CB_ALIGN) as usize)?;
        line.0.get(((offset % CB_ALIGN) / 4) as usize)
    }

    fn store(&self, offset: u32, v: u32) {
        if let Some(w) = self.word(offset) {
            w.store(v, Ordering::Release);
        }
    }

    /// The header: magic, layout version, capability bits, boot epoch; status Booting; the input
    /// ring idle (the first publish wakes the worker, plan #68 C2a1 §3.1).
    pub(crate) fn write_header(&self, caps: u32, epoch: u32) {
        self.store(off::MAGIC, u32::from_le_bytes(MAGIC));
        self.store(off::LAYOUT_VERSION, u32::from(LAYOUT_VERSION));
        self.store(off::CAPS, caps);
        self.store(off::BOOT_EPOCH, epoch);
        self.store(off::INPUT_IDLE, 1);
        self.set_status(Status::Booting);
    }

    /// Adds `n` to a counter word (relaxed: a statistic).
    pub(crate) fn add(&self, offset: u32, n: u32) {
        if let Some(w) = self.word(offset) {
            w.fetch_add(n, Ordering::Relaxed);
        }
    }

    pub(crate) fn or_caps(&self, bits: u32) {
        if let Some(w) = self.word(off::CAPS) {
            w.fetch_or(bits, Ordering::AcqRel);
        }
    }

    pub(crate) fn set_status(&self, s: Status) {
        self.store(off::STATUS, s as u32);
    }

    /// The frame clock: frames presented and the last present (main time origin).
    pub(crate) fn write_clock(&self, frame_no: u64, last_present_ms: f64) {
        self.store(off::FRAME_NO, frame_no as u32);
        self.store(off::FRAME_NO + 4, (frame_no >> 32) as u32);
        let bits = last_present_ms.to_bits();
        self.store(off::LAST_PRESENT_MS, bits as u32);
        self.store(off::LAST_PRESENT_MS + 4, (bits >> 32) as u32);
    }
}

impl Words for Control {
    fn load(&self, off: u32, o: Ordering) -> u32 {
        self.word(off).map_or(0, |w| w.load(o))
    }

    fn store(&self, off: u32, v: u32, o: Ordering) {
        if let Some(w) = self.word(off) {
            w.store(v, o);
        }
    }

    fn swap(&self, off: u32, v: u32, o: Ordering) -> u32 {
        self.word(off).map_or(0, |w| w.swap(v, o))
    }
}
