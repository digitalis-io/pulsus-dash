//! Scales. Design: T02 (L2).
//!
//! #24 adds the line chart's numeric core: true sample positions and device-pixel columns, the
//! null-aware min/max pyramid and the decimation specification ([`lod`], T02-014, T02-015), the
//! exact line-coverage rasteriser ([`raster`], VIZ-006) and nice ticks ([`ticks`]).

pub mod lod;
pub mod raster;
pub mod ticks;

/// The plot rectangle in device pixels, y up from the canvas bottom.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plot {
    pub x0: f32,
    pub y0: f32,
    pub w: u32,
    pub h: u32,
}
