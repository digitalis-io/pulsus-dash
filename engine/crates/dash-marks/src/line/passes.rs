//! The selection's line passes (plan #68 C2c2 §3.3; ADR-0025 decision 4, ADR-0032).

use super::gpu::Renderer;

/// One pass of a Line item, as the test hook logs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PassKind {
    /// No emphasis: every lane and the guides, at the series' colours.
    All,
    /// The guides only, onto the frame.
    A1,
    /// Lane 0 (the unmatched series) into the dim layer.
    A2,
    /// The dim layer composited onto the frame at `dimmed`.
    A3,
    /// The r-th matched series' `focus` underlay.
    B(u32),
    /// The r-th matched series' line.
    C(u32),
}

impl Renderer {
    /// Test hook: the passes of the last render's Line items, in order.
    pub fn last_passes(&self) -> Vec<PassKind> {
        Vec::new()
    }

    /// Test hook: the dim layer's device size, while it exists.
    pub fn dim_layer_size(&self) -> Option<(u32, u32)> {
        None
    }
}
