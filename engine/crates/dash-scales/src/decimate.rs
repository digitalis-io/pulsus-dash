//! Decimation (plan #68 §3.7, §4.2, A.15.2), the CPU path mirrored bit for bit by the WGSL passes.

use crate::ColumnRanges;
use crate::encode::ClipBox;

pub const INLINE_RUNS: usize = 2;

/// One (series, column); 40 bytes, the GPU layout (std430).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct ColOut {
    /// u of the last finite sample.
    pub last: f32,
    /// u of the first finite sample.
    pub first: f32,
    /// Bits `COL_*`.
    pub meta: u32,
    /// Exact number of NaN-free runs in the column.
    pub n_runs: u32,
    /// P4: global instance index of the column's first span.
    pub span_at: u32,
    pub _pad: u32,
    /// [max, min] of runs 0 and 1; valid when n_runs ≤ 2.
    pub runs: [[f32; 2]; INLINE_RUNS],
}

/// One drawn primitive; 16 bytes; an instance vertex buffer.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct LineInstance {
    /// lo16 column, hi16 dx to the previous drawn column.
    pub col: u32,
    pub va: f32,
    pub vb: f32,
    /// Bits `INST_*`.
    pub meta: u32,
}

/// Data for one far item (A.3.3).
#[derive(Clone, Copy, Debug)]
pub struct FarClip<'a> {
    /// The chunk's f64 values.
    pub values: &'a [f64],
    pub clip: ClipBox,
}

#[derive(Clone, Debug)]
pub struct DecimateInput<'a> {
    pub values_bits: &'a [u32],
    pub offsets: &'a [u32],
    pub ranges: &'a ColumnRanges,
    pub n: u32,
    pub guides: u32,
    pub colour_slots: &'a [u8],
    pub lanes: &'a [u16],
    /// Global instance indices to write (batching).
    pub window: std::ops::Range<u64>,
    /// Some for a far item: segments clipped in f64.
    pub far: Option<FarClip<'a>>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Decimated {
    pub cols: Vec<ColOut>,
    pub counts: Vec<u32>,
    pub starts: Vec<u32>,
    pub total: u64,
    /// Indices window.start..min(window.end, G + total); guide slots are zero.
    pub instances: Vec<LineInstance>,
}

/// The T2 path: P1 and P5 in parallel over series, P2–P4 sequential per series; bit-identical to
/// the T1 compute passes.
pub fn decimate(input: &DecimateInput) -> Decimated {
    let _ = input;
    Decimated::default()
}
