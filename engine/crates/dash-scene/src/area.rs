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

fn class_of(y: f32, top: f32, bottom: f32) -> PieceClass {
    if y < top {
        PieceClass::Above
    } else if y > bottom {
        PieceClass::Below
    } else {
        PieceClass::Inside
    }
}

/// The pieces of the join over [x0, x1] whose line runs through the finite points `a` and `b`
/// (x0 ≤ a.x ≤ b.x ≤ x1: a clipped end's rebuilt point; the span before `a` and after `b` has that
/// end's class). Empty when x1 ≤ x0. The crossings of `top` and `bottom` split the span in x
/// order; the only division is by b.y − a.y, between ends of different classes.
pub fn area_pieces(
    x0: f32,
    x1: f32,
    a: [f32; 2],
    b: [f32; 2],
    top: f32,
    bottom: f32,
) -> Vec<AreaPiece> {
    if x1 <= x0 {
        return Vec::new();
    }
    let (ka, kb) = (class_of(a[1], top, bottom), class_of(b[1], top, bottom));
    let cross = |y: f32| (a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])).clamp(x0, x1);
    // (x, y, class after it) of each boundary passed.
    let mut cuts: Vec<(f32, f32, PieceClass)> = Vec::with_capacity(2);
    if ka != kb {
        if a[1] < b[1] {
            if ka == PieceClass::Above {
                cuts.push((cross(top), top, PieceClass::Inside));
            }
            if kb == PieceClass::Below {
                cuts.push((cross(bottom), bottom, PieceClass::Below));
            }
        } else {
            if ka == PieceClass::Below {
                cuts.push((cross(bottom), bottom, PieceClass::Inside));
            }
            if kb == PieceClass::Above {
                cuts.push((cross(top), top, PieceClass::Above));
            }
        }
    }
    let edge = |k: PieceClass, line: f32| match k {
        PieceClass::Above => top,
        PieceClass::Below => bottom,
        PieceClass::Inside => line,
    };
    let mut out = Vec::with_capacity(3);
    let (mut k, mut x, mut y) = (ka, x0, a[1]);
    for (cx, cy, next) in cuts {
        let cx = cx.max(x);
        out.push(AreaPiece {
            class: k,
            x0: x,
            x1: cx,
            y0: edge(k, y),
            y1: edge(k, cy),
        });
        (k, x, y) = (next, cx, cy);
    }
    out.push(AreaPiece {
        class: k,
        x0: x,
        x1,
        y0: edge(k, y),
        y1: edge(k, b[1]),
    });
    out
}

/// The join of one decimated instance, as `area.wgsl` rebuilds it: None unless a SEGMENT with
/// x1 > x0. x0 and x1 are the previous and this column's centres (integer column subtraction);
/// each end is `y_of(u)`, or, when cut (flags bits 8–11), the cut point at the clip plane:
/// x0 + t·(x1 − x0) with t in `va`/`vb`, y = `y_of(±U_CLAMP)`. `plot` is x, y, w, h CSS px;
/// `axis` is (ku, ou).
pub fn join_ends(
    col: u32,
    va: f32,
    vb: f32,
    meta: u32,
    plot: [f32; 4],
    axis: (f32, f32),
) -> Option<(f32, f32, [f32; 2], [f32; 2])> {
    use dash_scales::decimate::{
        CLIP_LOW, INST_CLIP_A_SHIFT, INST_CLIP_B_SHIFT, INST_KIND_SHIFT, KIND_SEGMENT,
    };
    if (meta >> INST_KIND_SHIFT) & 3 != KIND_SEGMENT {
        return None;
    }
    let c = col & 0xFFFF;
    let p = c.checked_sub(col >> 16)?;
    let x1 = plot[0] + c as f32 + 0.5;
    let x0 = plot[0] + p as f32 + 0.5;
    if x1 <= x0 {
        return None;
    }
    let u_clamp = dash_scales::encode::U_CLAMP as f32;
    let y_of = |u: f32| plot[1] + plot[3] - (u - axis.1) * axis.0;
    let clipped = |code: u32| if code == CLIP_LOW { -u_clamp } else { u_clamp };
    let (ca, cb) = (
        (meta >> INST_CLIP_A_SHIFT) & 3,
        (meta >> INST_CLIP_B_SHIFT) & 3,
    );
    let a = if ca == 0 {
        [x0, y_of(va)]
    } else {
        [x0 + va * (x1 - x0), y_of(clipped(ca))]
    };
    let b = if cb == 0 {
        [x1, y_of(vb)]
    } else {
        [x0 + vb * (x1 - x0), y_of(clipped(cb))]
    };
    Some((x0, x1, a, b))
}
