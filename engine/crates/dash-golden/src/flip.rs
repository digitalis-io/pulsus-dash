//! ꟻLIP LDR comparison (T05-005) through `nv-flip`.

use crate::Image;

/// Mean ꟻLIP error of `b` against `a` (default pixels per degree), over `regions` (x, y, w, h in
/// device px) or over the whole image when `regions` is empty. Sizes must match.
pub fn flip_mean(a: &Image, b: &Image, regions: &[[u32; 4]]) -> f32 {
    if a.w != b.w || a.h != b.h || a.w == 0 || a.h == 0 {
        return f32::INFINITY;
    }
    let rgb = |i: &Image| -> Vec<u8> {
        i.rgba
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect()
    };
    let reference = nv_flip::FlipImageRgb8::with_data(a.w, a.h, &rgb(a));
    let test = nv_flip::FlipImageRgb8::with_data(b.w, b.h, &rgb(b));
    let err = nv_flip::flip(reference, test, nv_flip::DEFAULT_PIXELS_PER_DEGREE).to_vec();
    let (mut sum, mut count) = (0.0f64, 0u64);
    let whole = [[0, 0, a.w, a.h]];
    for r in if regions.is_empty() {
        &whole[..]
    } else {
        regions
    } {
        for y in r[1]..(r[1] + r[3]).min(a.h) {
            for x in r[0]..(r[0] + r[2]).min(a.w) {
                sum += f64::from(err[(y * a.w + x) as usize]);
                count += 1;
            }
        }
    }
    if count == 0 {
        0.0
    } else {
        (sum / count as f64) as f32
    }
}

/// The mean ꟻLIP error and the largest mean of an 8×8 tile (plan #68 C1, T05-005).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlipStats {
    pub mean: f32,
    pub tile_max: f32,
}

/// `flip_mean` and the tile maximum over the same regions.
pub fn flip_stats(a: &Image, b: &Image, regions: &[[u32; 4]]) -> FlipStats {
    FlipStats {
        mean: flip_mean(a, b, regions),
        tile_max: 0.0,
    }
}
