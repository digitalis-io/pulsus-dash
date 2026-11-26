//! Device-loss recovery policy (plan #68 C1 §4.3), target-independent so it is tested natively:
//! the first loss in 60 s restores the device; a second loss within 60 s, or a restore that
//! finds no GPU, is fatal (the main thread treats `fatal` as a second trap); a restore that lands
//! on another tier than the frames were created on moves those frames to Canvas 2D.

use dash_gpu::Tier;

use crate::events::{self, FailReason};

/// A second device loss within this window is fatal.
pub const LOST_AGAIN_MS: f64 = 60_000.0;

/// What a device loss leads to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LossAction {
    /// Request a new device on the same canvases.
    Restore,
    /// The engine cannot go on.
    Fatal,
}

/// The losses seen so far.
#[derive(Clone, Copy, Debug, Default)]
pub struct LossPolicy {
    lost_at: Option<f64>,
}

impl LossPolicy {
    /// A loss reported at `now_ms` (main time origin).
    pub fn on_lost(&mut self, now_ms: f64) -> LossAction {
        if self.lost_at.is_some_and(|t| now_ms - t < LOST_AGAIN_MS) {
            return LossAction::Fatal;
        }
        self.lost_at = Some(now_ms);
        LossAction::Restore
    }
}

/// How a restore ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Restored {
    /// A device on the frames' tier: every frame is redrawn on its canvas.
    Same,
    /// A device on another tier: the frames' canvases are set up for the old tier.
    TierChanged(Tier),
    /// No device.
    Failed,
}

/// The outcome of a restore from tier `old` that found `new` (None: no GPU).
pub fn restored(old: Tier, new: Option<Tier>) -> Restored {
    match new {
        None => Restored::Failed,
        Some(t) if t == old => Restored::Same,
        Some(t) => Restored::TierChanged(t),
    }
}

/// The events of a restore over the frames `ids`: none when the tier holds; on a tier change the
/// new tier with its status and `adapter`, then `failed{tier}` for every frame (each moves to
/// Canvas 2D; later frames use the new tier); `fatal` when no device was found.
pub fn restore_events(ids: &[u32], outcome: Restored, adapter: &str) -> Vec<String> {
    match outcome {
        Restored::Same => Vec::new(),
        Restored::TierChanged(t) => std::iter::once(events::tier(t, adapter))
            .chain(ids.iter().map(|id| events::failed(*id, FailReason::Tier)))
            .collect(),
        Restored::Failed => vec![events::fatal("device-lost")],
    }
}
