//! The line area's piecewise edge rule (#282 Part 2b §3.4, ADR-0036), the reference of
//! `area.wgsl`: one join's span [x0, x1] split where the line crosses the plot's top and bottom
//! rows. Above the plot the area fills from `top`, inside from the line, below not at all. f32, as
//! the shader computes it; the Canvas 2D engine's `areaPieces` works in value space instead.

/// Where a piece of a join lies against the plot rows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PieceClass {
    /// Above `top`: filled from `top`.
    Above,
    /// Between the rows: filled from the line.
    Inside,
    /// Below `bottom`: not filled.
    Below,
}

/// One piece over [x0, x1]: the area's top edge runs from (x0, y0) to (x1, y1) (`top` for
/// `Above`, the line for `Inside`, `bottom` for `Below`). CSS px, y down.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AreaPiece {
    pub class: PieceClass,
    pub x0: f32,
    pub x1: f32,
    pub y0: f32,
    pub y1: f32,
}

/// The pieces of the join from `a` to `b` over [x0, x1] (stub).
pub fn area_pieces(
    _x0: f32,
    _x1: f32,
    _a: [f32; 2],
    _b: [f32; 2],
    _top: f32,
    _bottom: f32,
) -> Vec<AreaPiece> {
    Vec::new()
}

/// The join of one instance (stub).
pub fn join_ends(
    _col: u32,
    _va: f32,
    _vb: f32,
    _meta: u32,
    _plot: [f32; 4],
    _axis: (f32, f32),
) -> Option<(f32, f32, [f32; 2], [f32; 2])> {
    None
}
