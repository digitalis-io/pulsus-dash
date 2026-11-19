//! The control block (T03 §4.3): allocation and typed atomic views of its words.
//!
//! The render worker allocates one zeroed `CB_SIZE` block, 64-byte aligned, and leaks it: it
//! lives as long as the worker's memory. Every shared word is accessed atomically (the shim
//! reads and writes the same words through `Atomics` on views of the memory).

use std::alloc::Layout;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicU8, AtomicU32, AtomicU64, Ordering};

use dash_protocol::layout::{CB_ALIGN, CB_SIZE, LAYOUT_VERSION, MAGIC, off};
use dash_protocol::ring::RingView;
use dash_protocol::status::RuntimeStatus;

/// A leaked, zeroed, 64-byte aligned `CB_SIZE` block.
#[derive(Clone, Copy, Debug)]
pub struct Control {
    base: NonNull<u8>,
}

impl Control {
    /// Allocates and leaks a zeroed control block; `None` if the allocation fails.
    pub fn alloc() -> Option<Control> {
        let layout = Layout::from_size_align(CB_SIZE as usize, CB_ALIGN as usize).ok()?;
        // SAFETY: the layout has a non-zero size. The block is never deallocated (leaked).
        let p = unsafe { std::alloc::alloc_zeroed(layout) };
        NonNull::new(p).map(|base| Control { base })
    }

    /// The block's address in linear memory.
    pub fn addr(self) -> usize {
        self.base.as_ptr() as usize
    }

    /// Clamps `at` to an `n`-aligned offset of an `n`-byte value inside the block.
    fn at(at: u32, n: u32) -> usize {
        debug_assert!(
            at.is_multiple_of(n) && at + n <= CB_SIZE,
            "control block offset {at:#x}"
        );
        (at.min(CB_SIZE - n) & !(n - 1)) as usize
    }

    /// The `u32` word at byte offset `at` (4-aligned, inside the block).
    pub fn word(self, at: u32) -> &'static AtomicU32 {
        // SAFETY: `base` is valid, 64-byte aligned and leaked ('static) for CB_SIZE bytes; the
        // offset is clamped to an aligned word inside it; shared words are only used atomically.
        unsafe { &*self.base.as_ptr().add(Self::at(at, 4)).cast::<AtomicU32>() }
    }

    /// The `u64` word at byte offset `at` (8-aligned, inside the block).
    pub fn word64(self, at: u32) -> &'static AtomicU64 {
        // SAFETY: as `word`, for an 8-aligned, 8-byte word.
        unsafe { &*self.base.as_ptr().add(Self::at(at, 8)).cast::<AtomicU64>() }
    }

    /// The byte at offset `at`.
    pub fn byte(self, at: u32) -> &'static AtomicU8 {
        // SAFETY: as `word`, for one byte.
        unsafe { &*self.base.as_ptr().add(Self::at(at, 1)).cast::<AtomicU8>() }
    }

    /// Writes the header (magic, layout version, capability bits, boot epoch 1) and `Booting`.
    pub fn write_header(self, caps: u32) {
        self.word(off::MAGIC)
            .store(u32::from_le_bytes(MAGIC), Ordering::Relaxed);
        self.word(off::LAYOUT_VERSION)
            .store(u32::from(LAYOUT_VERSION), Ordering::Relaxed);
        self.word(off::CAPS).store(caps, Ordering::Relaxed);
        self.word(off::BOOT_EPOCH).store(1, Ordering::Relaxed);
        self.set_status(RuntimeStatus::Booting as u32);
    }

    /// The `STATUS` word.
    pub fn status(self) -> u32 {
        self.word(off::STATUS).load(Ordering::Acquire)
    }

    pub fn set_status(self, code: u32) {
        self.word(off::STATUS).store(code, Ordering::Release);
    }

    /// The input ring of this block.
    pub fn input_ring(self) -> RingView {
        // SAFETY: the block is valid, 64-byte aligned and leaked for CB_SIZE bytes. Callers keep
        // one producer (the shim or `render_input`) and one consumer (the frame loop).
        unsafe { RingView::input(self.base.as_ptr()) }
    }
}
