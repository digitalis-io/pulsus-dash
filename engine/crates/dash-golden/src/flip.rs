//! ꟻLIP LDR comparison (T05-005) through `nv-flip`.

use crate::Image;

/// Mean ꟻLIP error of `b` against `a` (default pixels per degree), over `regions` (x, y, w, h in
/// device px) or over the whole image when `regions` is empty. Sizes must match.
pub fn flip_mean(a: &Image, b: &Image, regions: &[[u32; 4]]) -> f32 {
    let _ = (a, b, regions);
    f32::INFINITY
}
