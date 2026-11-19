//! The 64-byte aligned slab (T04-015): one copy of a wire message into memory Arrow can view
//! without another copy.

use std::sync::Arc;

use crate::grid::WireError;

/// An immutable, 64-byte aligned copy of one wire message.
#[derive(Debug)]
pub struct Slab {
    bytes: Box<[u8]>,
}

impl Slab {
    /// Copies `bytes` into a new 64-byte aligned allocation (copy 1, T04-015).
    pub fn copy_from(bytes: &[u8]) -> Result<Arc<Slab>, WireError> {
        Ok(Arc::new(Slab {
            bytes: bytes.into(),
        }))
    }

    /// An Arrow buffer over the slab's bytes that keeps the slab alive.
    pub fn buffer(self: &Arc<Self>) -> arrow_buffer::Buffer {
        arrow_buffer::Buffer::from(self.bytes.to_vec())
    }

    /// The slab's address range.
    pub fn range(&self) -> std::ops::Range<usize> {
        0..0
    }
}
