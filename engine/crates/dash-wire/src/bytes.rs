//! `SharedBytes`: immutable, shared, 64-aligned bytes for network slabs and split-frame payloads
//! (plan #68 B2 §3.1, T04-015 as amended).

use std::fmt;
use std::sync::Arc;

/// The allocation unit: 64 bytes, 64-aligned, so every backing allocation starts on a 64-byte
/// boundary.
#[repr(C, align(64))]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct Block([u8; 64]);

/// A zeroed, uniquely owned 64-aligned allocation of `blocks` blocks (one allocation, no copy).
fn zeroed(blocks: usize) -> Arc<[Block]> {
    std::iter::repeat_n(Block([0; 64]), blocks).collect()
}

/// Immutable shared bytes; the backing allocation is 64-aligned. Clone is an `Arc` clone.
#[derive(Clone)]
pub struct SharedBytes {
    buf: Arc<[Block]>,
    off: usize,
    len: usize,
}

impl SharedBytes {
    /// Copies `data` so that it starts at byte `lead % 64` of a fresh 64-aligned allocation
    /// (keeps a body offset's position mod 64). The only constructor that copies.
    pub fn copy_from(data: &[u8], lead: usize) -> Self {
        let off = lead % 64;
        let mut b = PayloadBuf::new(data.len(), off);
        b.extend(data);
        b.freeze()
    }

    pub fn as_bytes(&self) -> &[u8] {
        let all: &[u8] = bytemuck::cast_slice(&self.buf);
        // Invariant: off + len ≤ the allocation (checked by every constructor and `slice`).
        all.get(self.off..self.off + self.len).unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// `len` bytes from `off`, sharing the allocation; `None` if out of range.
    pub fn slice(&self, off: usize, len: usize) -> Option<SharedBytes> {
        let end = off.checked_add(len)?;
        if end > self.len {
            return None;
        }
        Some(SharedBytes {
            buf: Arc::clone(&self.buf),
            off: self.off + off,
            len,
        })
    }

    /// How many `SharedBytes` share this allocation (memory accounting and the T04-015
    /// "nothing pinned" test).
    pub fn strong_count(&self) -> usize {
        Arc::strong_count(&self.buf)
    }

    /// The size of the whole backing allocation (stub).
    pub fn backing_len(&self) -> usize {
        0
    }
}

/// Copies `data` into slabs (stub).
pub fn slabs_from(data: &[u8], body_offset: u64, _max: usize) -> impl Iterator<Item = SharedBytes> {
    std::iter::once(SharedBytes::copy_from(data, (body_offset % 64) as usize))
}

impl PartialEq for SharedBytes {
    fn eq(&self, other: &Self) -> bool {
        self.as_bytes() == other.as_bytes()
    }
}

impl fmt::Debug for SharedBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "SharedBytes({} bytes)", self.len)
    }
}

/// A payload being filled from several chunks: one zeroed allocation of the final size, written
/// in place and frozen without a further copy (the split-frame buffer of T04-015).
#[derive(Debug)]
pub(crate) struct PayloadBuf {
    buf: Arc<[Block]>,
    off: usize,
    len: usize,
    filled: usize,
}

impl PayloadBuf {
    /// Room for `len` bytes starting at byte `off` (< 64) of the allocation.
    pub(crate) fn new(len: usize, off: usize) -> Self {
        let blocks = (off + len).div_ceil(64);
        Self {
            buf: zeroed(blocks),
            off,
            len,
            filled: 0,
        }
    }

    /// Bytes still missing.
    pub(crate) fn missing(&self) -> usize {
        self.len - self.filled
    }

    /// Appends up to `missing()` bytes of `data`; returns how many were taken.
    pub(crate) fn extend(&mut self, data: &[u8]) -> usize {
        let n = data.len().min(self.missing());
        let start = self.off + self.filled;
        // The allocation is uniquely owned until `freeze`.
        if let Some(blocks) = Arc::get_mut(&mut self.buf) {
            let all: &mut [u8] = bytemuck::cast_slice_mut(blocks);
            if let (Some(dst), Some(src)) = (all.get_mut(start..start + n), data.get(..n)) {
                dst.copy_from_slice(src);
                self.filled += n;
                return n;
            }
        }
        0
    }

    pub(crate) fn freeze(self) -> SharedBytes {
        SharedBytes {
            buf: self.buf,
            off: self.off,
            len: self.len,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_keeps_position_mod_64() {
        for lead in [0usize, 1, 8, 63, 64, 130] {
            let b = SharedBytes::copy_from(&[1, 2, 3], lead);
            assert_eq!(b.as_bytes(), &[1, 2, 3]);
            assert_eq!(b.as_bytes().as_ptr() as usize % 64, lead % 64);
        }
        let b = SharedBytes::copy_from(&[], 5);
        assert!(b.is_empty());
    }

    #[test]
    fn slices_share_and_check_range() {
        let b = SharedBytes::copy_from(&[0, 1, 2, 3, 4], 0);
        let s = b.slice(1, 3);
        assert_eq!(
            s.as_ref().map(SharedBytes::as_bytes),
            Some(&[1u8, 2, 3][..])
        );
        assert_eq!(b.strong_count(), 2);
        assert!(b.slice(3, 3).is_none());
        assert!(b.slice(usize::MAX, 2).is_none());
        drop(s);
        assert_eq!(b.strong_count(), 1);
    }
}
