//! `Sync::Defer` (plan #68 C1 §3.1): the T1 status read-back without blocking. A render whose
//! total is unknown copies status bytes 0..32 (draw-indirect args, then w4 = the uncapped total)
//! into a 32-byte MAP_READ buffer and maps it; [`Renderer::poll`] reports the outcome. A failed
//! read-back asks for a rerun; the third failure in a row is final.

use std::sync::Arc;
use std::sync::atomic::{AtomicU8, Ordering};

use dash_scales::encode::Encoding;

use super::gpu::{Pending, RangesKey, Renderer};
use crate::desc::DrawnEvent;

/// What a T1 line item's total depends on: its column ranges (chunk, series, window, columns,
/// DPR), its encoding and the guides drawn before it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct TotalKey {
    pub(super) ranges: RangesKey,
    pub(super) encoding: Encoding,
    pub(super) guides: u32,
}

/// Map states shared with the `map_async` callback.
const MAP_WAITING: u8 = 0;
const MAP_OK: u8 = 1;
const MAP_ERR: u8 = 2;

/// Read-backs that may fail in a row before the frame gives up (T03-025).
const MAX_READ_FAILURES: u32 = 3;

/// One outstanding status read-back.
#[derive(Debug)]
pub(super) struct Readback {
    buf: wgpu::Buffer,
    state: Arc<AtomicU8>,
    key: TotalKey,
    /// Guides and instance capacity of the frame drawn.
    guides: u64,
    cap: u64,
    /// Test hook (`fail_maps_after`): report this map as failed.
    fail: bool,
    /// The frame's drawn event, if it is complete.
    pub(super) drawn: Option<DrawnEvent>,
}

impl Readback {
    /// Maps `buf` (32 bytes, MAP_READ, already the target of a submitted copy).
    pub(super) fn start(
        buf: wgpu::Buffer,
        key: TotalKey,
        guides: u64,
        cap: u64,
        fail: bool,
    ) -> Self {
        let state = Arc::new(AtomicU8::new(MAP_WAITING));
        let s = state.clone();
        buf.slice(..).map_async(wgpu::MapMode::Read, move |r| {
            s.store(if r.is_ok() { MAP_OK } else { MAP_ERR }, Ordering::Release);
        });
        Self {
            buf,
            state,
            key,
            guides,
            cap,
            fail,
            drawn: None,
        }
    }

    /// w4 of the mapped header.
    fn total(&self) -> Option<u64> {
        let bytes = self.buf.slice(..).get_mapped_range().ok()?;
        let w4 = bytes
            .get(16..20)
            .map(|b| u64::from(bytemuck::pod_read_unaligned::<u32>(b)));
        drop(bytes);
        self.buf.unmap();
        w4
    }
}

impl Renderer {
    /// `Sync::Defer`: the outcome of the last render's status read-back. `Idle` when nothing is
    /// outstanding (always under `Block`); `Waiting` until the map completes; then `Complete` (the
    /// frame drawn was whole: guides + total ≤ capacity), `Rerun` (under-sized, or the read-back
    /// failed: the next render knows the total and sizes for it) or, at the third failed read-back
    /// in a row, `Failed`.
    pub fn poll(&mut self) -> Pending {
        let Some(p) = self.pending.as_ref() else {
            return Pending::Idle;
        };
        let state = p.state.load(Ordering::Acquire);
        if state == MAP_WAITING {
            return Pending::Waiting;
        }
        let total = (state == MAP_OK && !p.fail).then(|| p.total()).flatten();
        let Some(p) = self.pending.take() else {
            return Pending::Idle;
        };
        let Some(total) = total else {
            self.read_failures += 1;
            if self.read_failures >= MAX_READ_FAILURES {
                self.read_failures = 0;
                return Pending::Failed;
            }
            return Pending::Rerun;
        };
        self.read_failures = 0;
        self.known = Some((p.key, total));
        self.total = Some(total);
        match p.drawn {
            Some(d) if p.guides + total <= p.cap => Pending::Complete(d),
            _ => Pending::Rerun,
        }
    }
}
