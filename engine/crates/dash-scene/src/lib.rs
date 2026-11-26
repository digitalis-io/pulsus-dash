//! The scene model (T02-020): viewports, cameras, specs, frame summaries and the frame build
//! (plan #68 §3.8). No GPU dependency: `dash-marks` is used for its descriptions only.

mod build;
pub mod camera;
pub mod hover;
pub mod layer;
mod spec;
mod summary;

pub use build::{Built, StageInfo, build, build_frame};
pub use camera::{Camera, PlotCamera, YRange};
pub use spec::{
    LineSpec, MAX_THRESHOLDS, SpecError, ThresholdLine, ThresholdState, ValueRange, VisSpec,
};
pub use summary::{CommitEvent, FrameSummary, Gesture, TimeWindow, ValueAxisSummary, ValueCommit};

pub use dash_axes::{Band, PlotRect, ValueAxis, VisKind};
pub use dash_scales::Range64;
pub use dash_tokens::Theme;

use std::sync::Arc;

use dash_wire::Chunk;

/// CSS px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size64 {
    pub w: f64,
    pub h: f64,
}

/// One ChartFrame.
#[derive(Clone, Debug)]
pub struct Viewport {
    pub id: u32,
    /// FrameInit.id (ADR-0019): diagnostic only.
    pub frame_id: Option<String>,
    pub css: Size64,
    pub dpr: f32,
    pub theme: Theme,
    /// Set by the caller (D-GESTURE); `build` only reads it.
    pub camera: Camera,
    pub spec: VisSpec,
    pub data: Option<Arc<Chunk>>,
    /// Set by the caller (D-GESTURE); `build` only reads it.
    pub band: Band,
    /// The event markers' times, ms (`EventMarker.atMs`, plan #68 C2c1): every event the frame
    /// holds, in call order; NaN kept (not drawn).
    pub events: Arc<[f64]>,
}

/// All viewports of a page (T02-020).
#[derive(Clone, Debug, Default)]
pub struct Scene {
    pub viewports: Vec<Viewport>,
}
