//! Generated design tokens. Design: T01 §4.5. Stub created by #22; implemented by M-UI0 token-source issue (epic #3).

/// Provisional colours and sizes of the #23 runtime spike and the #24 line chart; replaced by
/// epic #3.
pub mod spike {
    /// Canvas clear colour (linear RGBA, written as-is to the non-sRGB surface format).
    pub const CANVAS_BG: [f64; 4] = [0.04, 0.05, 0.07, 1.0];
    /// Rect mark colour (linear RGBA).
    pub const MARK: [f32; 4] = [0.20, 0.62, 0.86, 1.0];
    /// Line mark colour (linear RGBA).
    pub const LINE: [f32; 4] = [0.20, 0.62, 0.86, 1.0];
    /// Gridline colour (linear RGBA).
    pub const GRID: [f32; 4] = [0.10, 0.12, 0.16, 1.0];
    /// Axis line and tick colour (linear RGBA).
    pub const AXIS: [f32; 4] = [0.30, 0.33, 0.40, 1.0];
    /// Line width in CSS px.
    pub const LINE_WIDTH_CSS: f32 = 1.0;
    /// Plot insets in CSS px: left, right, top, bottom.
    pub const PLOT_INSET_CSS: [f32; 4] = [48.0, 8.0, 8.0, 24.0];
}
