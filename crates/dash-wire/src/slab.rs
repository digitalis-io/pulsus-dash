//! The 64-byte aligned slab (T04-015): one copy of a wire message into memory Arrow can view
//! without another copy.

use std::alloc::Layout;
use std::ptr::NonNull;
use std::sync::Arc;

use crate::grid::WireError;

/// Slab alignment: Arrow's buffer alignment, so zero-copy views need no realignment.
pub const SLAB_ALIGN: usize = 64;

/// An immutable, 64-byte aligned copy of one wire message.
pub struct Slab {
    ptr: NonNull<u8>,
    len: usize,
}

// SAFETY: the slab exclusively owns its allocation and never mutates it after `copy_from`;
// shared references only read it.
unsafe impl Send for Slab {}
// SAFETY: as above (immutable after construction).
unsafe impl Sync for Slab {}

impl std::fmt::Debug for Slab {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slab").field("len", &self.len).finish()
    }
}

fn layout(len: usize) -> Result<Layout, WireError> {
    Layout::from_size_align(len.max(1), SLAB_ALIGN).map_err(|_| WireError::Alloc)
}

impl Slab {
    /// Copies `bytes` into a new 64-byte aligned allocation (copy 1, T04-015).
    pub fn copy_from(bytes: &[u8]) -> Result<Arc<Slab>, WireError> {
        let layout = layout(bytes.len())?;
        // SAFETY: the layout has a non-zero size.
        let p = unsafe { std::alloc::alloc(layout) };
        let ptr = NonNull::new(p).ok_or(WireError::Alloc)?;
        // SAFETY: `p` is valid for `bytes.len()` bytes (≤ the layout size) and is a fresh
        // allocation, so it does not overlap `bytes`.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len()) };
        Ok(Arc::new(Slab {
            ptr,
            len: bytes.len(),
        }))
    }

    /// The slab's bytes.
    pub fn bytes(&self) -> &[u8] {
        // SAFETY: `ptr` is valid and initialised for `len` bytes for the slab's lifetime, and
        // never written after construction.
        unsafe { std::slice::from_raw_parts(self.ptr.as_ptr(), self.len) }
    }

    /// An Arrow buffer over the slab's bytes that keeps the slab alive (no copy).
    pub fn buffer(self: &Arc<Self>) -> arrow_buffer::Buffer {
        let owner: Arc<dyn arrow_buffer::alloc::Allocation> = self.clone();
        // SAFETY: `ptr` is valid for `len` immutable bytes while `owner` (this slab) is alive,
        // and the buffer holds `owner` for as long as it (or any slice of it) exists.
        unsafe { arrow_buffer::Buffer::from_custom_allocation(self.ptr, self.len, owner) }
    }

    /// The slab's address range.
    pub fn range(&self) -> std::ops::Range<usize> {
        let start = self.ptr.as_ptr() as usize;
        start..start + self.len
    }
}

impl Drop for Slab {
    fn drop(&mut self) {
        if let Ok(layout) = layout(self.len) {
            // SAFETY: `ptr` was allocated in `copy_from` with this same layout and is freed once.
            unsafe { std::alloc::dealloc(self.ptr.as_ptr(), layout) };
        }
    }
}
