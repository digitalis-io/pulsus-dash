//! The control block (T03 §4.3): allocation and typed atomic views of its words. Stub.

use std::ptr::NonNull;
use std::sync::atomic::AtomicU32;

use dash_protocol::ring::RingView;

/// A leaked, zeroed, 64-byte aligned `CB_SIZE` block.
#[derive(Clone, Copy, Debug)]
pub struct Control {
    base: NonNull<u8>,
}

impl Control {
    /// Allocates and leaks a zeroed control block; `None` if the allocation fails.
    pub fn alloc() -> Option<Control> {
        None
    }

    /// The block's address in linear memory.
    pub fn addr(self) -> usize {
        self.base.as_ptr() as usize
    }

    /// The `u32` word at byte offset `at` (4-aligned, inside the block).
    pub fn word(self, _at: u32) -> &'static AtomicU32 {
        static ZERO: AtomicU32 = AtomicU32::new(0);
        &ZERO
    }

    /// The input ring of this block.
    pub fn input_ring(self) -> RingView {
        // SAFETY: stub; the block is valid for CB_SIZE bytes for 'static.
        unsafe { RingView::input(self.base.as_ptr()) }
    }
}
