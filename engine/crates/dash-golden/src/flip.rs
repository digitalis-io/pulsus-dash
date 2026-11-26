//! ꟻLIP LDR comparison (T05-005) through `nv-flip`.

use crate::Image;

/// The ꟻLIP error of every pixel of `b` against `a` (default pixels per degree); `None` when the
/// sizes differ or are zero.
fn flip_map(a: &Image, b: &Image) -> Option<Vec<f32>> {
    if a.w != b.w || a.h != b.h || a.w == 0 || a.h == 0 {
        return None;
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
    Some(nv_flip::flip(reference, test, nv_flip::DEFAULT_PIXELS_PER_DEGREE).to_vec())
}

/// `regions` clamped to the image, or the whole image when empty.
fn clamped(a: &Image, regions: &[[u32; 4]]) -> Vec<[u32; 4]> {
    let whole = [[0, 0, a.w, a.h]];
    let rs = if regions.is_empty() {
        &whole[..]
    } else {
        regions
    };
    rs.iter()
        .map(|r| {
            let (x0, y0) = (r[0].min(a.w), r[1].min(a.h));
            let (x1, y1) = (
                r[0].saturating_add(r[2]).min(a.w),
                r[1].saturating_add(r[3]).min(a.h),
            );
            [x0, y0, x1, y1]
        })
        .collect()
}

/// Mean ꟻLIP error of `b` against `a` (default pixels per degree), over `regions` (x, y, w, h in
/// device px) or over the whole image when `regions` is empty. Sizes must match.
pub fn flip_mean(a: &Image, b: &Image, regions: &[[u32; 4]]) -> f32 {
    flip_stats(a, b, regions).mean
}

/// The mean ꟻLIP error and the largest mean of an 8×8 tile (plan #68 C1, T05-005).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FlipStats {
    pub mean: f32,
    /// Tiles start at each region's top-left corner; a partial tile at a region's right or bottom
    /// edge is the mean of the pixels it covers.
    pub tile_max: f32,
}

/// The edge of a `tile_max` tile, device px.
pub const TILE: u32 = 8;

/// `flip_mean` and the tile maximum over the same regions; both infinite when the sizes differ.
pub fn flip_stats(a: &Image, b: &Image, regions: &[[u32; 4]]) -> FlipStats {
    let Some(err) = flip_map(a, b) else {
        return FlipStats {
            mean: f32::INFINITY,
            tile_max: f32::INFINITY,
        };
    };
    let (mut sum, mut count, mut tile_max) = (0.0f64, 0u64, 0.0f64);
    for [x0, y0, x1, y1] in clamped(a, regions) {
        for ty in (y0..y1).step_by(TILE as usize) {
            for tx in (x0..x1).step_by(TILE as usize) {
                let (mut t_sum, mut t_n) = (0.0f64, 0u64);
                for y in ty..(ty + TILE).min(y1) {
                    for x in tx..(tx + TILE).min(x1) {
                        t_sum += f64::from(err[(y * a.w + x) as usize]);
                        t_n += 1;
                    }
                }
                sum += t_sum;
                count += t_n;
                if t_n > 0 {
                    tile_max = tile_max.max(t_sum / t_n as f64);
                }
            }
        }
    }
    if count == 0 {
        return FlipStats {
            mean: 0.0,
            tile_max: 0.0,
        };
    }
    FlipStats {
        mean: (sum / count as f64) as f32,
        tile_max: tile_max as f32,
    }
}
