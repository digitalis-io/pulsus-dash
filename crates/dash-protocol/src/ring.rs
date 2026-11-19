//! The SPSC input ring (T03-006): one producer (the shim in Full mode; `render_input` in ST
//! mode), one consumer (the render worker at frame start, T03-019).
//!
//! Head and tail are free-running `u32` byte counters (wrapping); a position is the counter
//! modulo `RING_BYTES`. Records are multiples of 8 bytes and never straddle the end: a record
//! that does not fit before the end is preceded by a one-byte `KIND_WRAP` marker and written at
//! offset 0. The producer writes the payload, then stores the head with release ordering; the
//! consumer loads the head with acquire ordering.

use std::sync::atomic::{AtomicU32, Ordering};

use crate::input::{InputRecord, KIND_WRAP, RecordHeader, decode};
use crate::layout::{CB_SIZE, RING_BYTES, off};

/// One SPSC ring in a control block (the base is shared memory; not `Send`-checked).
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
    /// The input ring of the control block at `base`.
    ///
    /// # Safety
    /// `base` is 64-byte aligned, valid for `CB_SIZE` bytes for `'static`, and only one producer
    /// and one consumer use this ring.
    pub unsafe fn input(base: *mut u8) -> Self {
        RingView {
            base,
            head_off: off::INPUT_HEAD,
            tail_off: off::INPUT_TAIL,
            data_off: off::INPUT_DATA,
        }
    }

    /// The `u32` word at control-block offset `at`, clamped to an aligned word inside the block.
    fn word(&self, at: u32) -> &AtomicU32 {
        let at = at.min(CB_SIZE - 4) & !3;
        // SAFETY: `input`'s contract makes `base` valid and 64-byte aligned for CB_SIZE bytes for
        // 'static; `at` is 4-aligned and `at + 4 <= CB_SIZE`; shared words are only accessed
        // atomically.
        unsafe { &*self.base.add(at as usize).cast::<AtomicU32>() }
    }

    fn data(&self) -> *mut u8 {
        // SAFETY: `data_off + RING_BYTES <= CB_SIZE` (layout v1), inside the block.
        unsafe { self.base.add(self.data_off as usize) }
    }

    /// Adds `n` (relaxed) to the `u32` counter at control-block offset `at` (e.g.
    /// `INPUT_OVERFLOW`, `FS_RING_CORRUPT`).
    pub fn add_counter(&self, at: u32, n: u32) {
        self.word(at).fetch_add(n, Ordering::Relaxed);
    }

    /// Consumer: loads the head (acquire), visits every complete record in order, follows
    /// `KIND_WRAP` markers to offset 0, then stores the tail (release). A record failing
    /// `decode`, or a marker at position 0 or not followed by published bytes after the end,
    /// moves the tail to the head and adds 1 to `FS_RING_CORRUPT` (records before it are
    /// visited). Returns the records visited.
    pub fn drain(&mut self, f: &mut dyn FnMut(RecordHeader, InputRecord)) -> u32 {
        let head = self.word(self.head_off).load(Ordering::Acquire);
        let mut tail = self.word(self.tail_off).load(Ordering::Relaxed);
        let mut n = 0;
        while tail != head {
            let pos = tail % RING_BYTES;
            let len = (RING_BYTES - pos).min(head.wrapping_sub(tail));
            // SAFETY: [pos, pos + len) lies inside the data region and holds bytes the producer
            // published before its release store of `head`; it cannot rewrite them until the
            // tail moves past them.
            let bytes =
                unsafe { std::slice::from_raw_parts(self.data().add(pos as usize), len as usize) };
            if bytes.first() == Some(&KIND_WRAP) {
                // The producer writes a marker only before a record it placed at offset 0, so a
                // valid marker is never at position 0 and the published bytes extend past the
                // end. Anything else is corruption: resync instead of skipping past the head.
                let to_end = RING_BYTES - pos;
                if pos != 0 && head.wrapping_sub(tail) > to_end {
                    tail = tail.wrapping_add(to_end);
                } else {
                    tail = head;
                    self.add_counter(off::FS_RING_CORRUPT, 1);
                }
                continue;
            }
            match decode(bytes) {
                Ok((h, r)) => {
                    tail = tail.wrapping_add(u32::from(h.size));
                    n += 1;
                    f(h, r);
                }
                Err(_) => {
                    tail = head;
                    self.add_counter(off::FS_RING_CORRUPT, 1);
                }
            }
        }
        self.word(self.tail_off).store(tail, Ordering::Release);
        n
    }

    /// Producer: writes one encoded record (a multiple of 8 bytes, ≤ `RING_BYTES`), then
    /// publishes it with a release store of the head. `RingFull` if it does not fit.
    pub fn push(&mut self, rec: &[u8]) -> Result<(), RingFull> {
        let size = u32::try_from(rec.len()).map_err(|_| RingFull)?;
        if size == 0 || size % 8 != 0 || size > RING_BYTES {
            return Err(RingFull);
        }
        let head = self.word(self.head_off).load(Ordering::Relaxed);
        let tail = self.word(self.tail_off).load(Ordering::Acquire);
        let pos = head % RING_BYTES;
        let to_end = RING_BYTES - pos;
        let wrap = to_end < size;
        let need = size + if wrap { to_end } else { 0 };
        let free = RING_BYTES - head.wrapping_sub(tail);
        if need > free {
            return Err(RingFull);
        }
        let at = if wrap { 0 } else { pos };
        // SAFETY: the bytes [pos, pos + need) modulo RING_BYTES are free (consumed), so the
        // producer owns them; `at + size <= RING_BYTES` and `pos < RING_BYTES` keep both writes
        // inside the data region.
        unsafe {
            if wrap {
                self.data().add(pos as usize).write(KIND_WRAP);
            }
            std::ptr::copy_nonoverlapping(rec.as_ptr(), self.data().add(at as usize), rec.len());
        }
        self.word(self.head_off)
            .store(head.wrapping_add(need), Ordering::Release);
        Ok(())
    }
}
