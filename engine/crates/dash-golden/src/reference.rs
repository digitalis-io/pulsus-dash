//! The A.4 structural reference (plan #68 A.4 with A.15.2's join and span rules): shapes written
//! from the ADR-0014 §4 note in f64, independent of `dash-scales::decimate`, `ColumnRanges` and the
//! engine passes. `A` = the sample pixels, `R⁺` = the shapes dilated by one device pixel.

use dash_scales::Range64;
use dash_wire::{Chunk, TimeAxis};

/// The geometry the reference draws, in device px.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Shape {
    /// A round-capped capsule from a to b.
    Capsule {
        a: (f64, f64),
        b: (f64, f64),
        r: f64,
    },
}

/// Inputs of the reference.
#[derive(Clone, Copy, Debug)]
pub struct RefFrame {
    /// x, y, w, h CSS px.
    pub plot: [f64; 4],
    pub window: (f64, f64),
    pub axis: Range64,
    pub dpr: f64,
    pub width_css: f64,
    /// Device px of the target.
    pub size: (u32, u32),
}

/// The masks of one fixture.
#[derive(Clone, Debug)]
pub struct RefMasks {
    /// In-plot pixels of every finite in-window sample.
    pub a: Vec<(u32, u32)>,
    /// R⁺, row-major over `size`.
    pub r_plus: Vec<bool>,
    pub shapes: Vec<Shape>,
}

impl RefFrame {
    pub fn n(&self) -> u32 {
        self.plot[2].floor().max(0.0) as u32
    }

    pub fn col(&self, t: f64) -> Option<u32> {
        let (from, to) = self.window;
        let n = self.n();
        if !(t >= from && t <= to) || n == 0 {
            return None;
        }
        let x = ((t - from) / (to - from) * f64::from(n)).floor();
        Some(x.clamp(0.0, f64::from(n - 1)) as u32)
    }

    /// y in CSS px (A.4 y rule).
    pub fn y(&self, v: f64) -> f64 {
        let a = self.axis;
        let q = if (a.hi - a.lo).is_finite() {
            (v - a.lo) / (a.hi - a.lo)
        } else {
            (v / 2.0 - a.lo / 2.0) / (a.hi / 2.0 - a.lo / 2.0)
        };
        self.plot[1] + self.plot[3] * (1.0 - q)
    }

    /// The device plot rect [x0, x1) × [y0, y1).
    pub fn device_plot(&self) -> (u32, u32, u32, u32) {
        let d = self.dpr;
        let p = self.plot;
        (
            (p[0] * d).floor() as u32,
            ((p[0] + p[2]) * d).ceil() as u32,
            (p[1] * d).floor() as u32,
            ((p[1] + p[3]) * d).ceil() as u32,
        )
    }
}

fn times(chunk: &Chunk, s: usize) -> Vec<f64> {
    let (a, b) = (chunk.offsets[s] as usize, chunk.offsets[s + 1] as usize);
    match &chunk.time {
        TimeAxis::Grid {
            start_ms, step_ms, ..
        } => (0..b - a)
            .map(|k| (start_ms + step_ms * k as i64) as f64)
            .collect(),
        TimeAxis::Explicit { t_ms } => t_ms[a..b].to_vec(),
    }
}

/// Cut parameter of bound `c` along v from `va` to `vb`.
fn cut(c: f64, va: f64, vb: f64) -> f64 {
    if (vb - va).is_finite() {
        (c - va) / (vb - va)
    } else {
        (c / 2.0 - va / 2.0) / (vb / 2.0 - va / 2.0)
    }
}

/// The reference shapes and masks of `chunk`.
pub fn reference_mask(chunk: &Chunk, f: &RefFrame) -> RefMasks {
    let d = f.dpr;
    let mut shapes = Vec::new();
    let mut a_px = Vec::new();
    let (px0, px1, py0, py1) = f.device_plot();
    // Value bounds of rows plot.y − 8 and plot.y + h + 8.
    let v_of_y = |y: f64| {
        let q = 1.0 - (y - f.plot[1]) / f.plot[3];
        let a = f.axis;
        if (a.hi - a.lo).is_finite() {
            a.lo + q * (a.hi - a.lo)
        } else {
            a.lo * (1.0 - q) + a.hi * q
        }
    };
    let (vtop, vbot) = (v_of_y(f.plot[1] - 8.0), v_of_y(f.plot[1] + f.plot[3] + 8.0));
    let (vlo, vhi) = (vbot.min(vtop), vbot.max(vtop));
    let xc = |c: u32| (f.plot[0] + f64::from(c) + 0.5) * d;
    let yd = |v: f64| f.y(v) * d;
    for s in 0..chunk.series.len() {
        let ts = times(chunk, s);
        let vs = &chunk.values[chunk.offsets[s] as usize..chunk.offsets[s + 1] as usize];
        // (column, value, gap before) of every finite in-window sample.
        let mut samples: Vec<(u32, f64, bool)> = Vec::new();
        let mut gap = false;
        for (t, v) in ts.iter().zip(vs) {
            let Some(c) = f.col(*t) else { continue };
            if !v.is_finite() {
                gap = true;
                continue;
            }
            samples.push((c, *v, gap));
            gap = false;
            let i = (f64::from(c) + 0.5) * d;
            let (ix, iy) = (
                i.floor() as u32 + (f.plot[0] * d).floor() as u32,
                yd(*v).floor(),
            );
            if ix >= px0 && ix < px1 && iy >= f64::from(py0) && iy < f64::from(py1) {
                a_px.push((ix, iy as u32));
            }
        }
        let r_line = 0.5 * f.width_css * d;
        for k in 0..samples.len() {
            let (c, v, gap_before) = samples[k];
            let joined_left = k > 0 && !gap_before;
            let joined_right = k + 1 < samples.len() && !samples[k + 1].2;
            if !joined_left && !joined_right {
                shapes.push(Shape::Capsule {
                    a: (xc(c), yd(v)),
                    b: (xc(c), yd(v)),
                    r: f.width_css * d,
                });
            }
            if !joined_right {
                continue;
            }
            let (c2, v2, _) = samples[k + 1];
            if c2 == c {
                // Within a column: one capsule per pair, the run's span.
                let (a, b) = (v.clamp(vlo, vhi), v2.clamp(vlo, vhi));
                shapes.push(Shape::Capsule {
                    a: (xc(c), yd(a)),
                    b: (xc(c), yd(b)),
                    r: r_line,
                });
                continue;
            }
            // Across columns: last of a column to first of the next, cut in f64 to the rows
            // (a cut end is the bound itself, at the cut parameter's x).
            let (mut a_end, mut b_end) = ((0.0, v), (1.0, v2));
            for (bound, low) in [(vlo, true), (vhi, false)] {
                let out = |x: f64| if low { x < bound } else { x > bound };
                if out(v) {
                    a_end = (cut(bound, v, v2), bound);
                }
                if out(v2) {
                    b_end = (cut(bound, v, v2), bound);
                }
            }
            if (v < vlo && v2 < vlo) || (v > vhi && v2 > vhi) || a_end.0 > b_end.0 {
                continue;
            }
            let at = |(t, val): (f64, f64)| (xc(c) + t * (xc(c2) - xc(c)), yd(val));
            shapes.push(Shape::Capsule {
                a: at(a_end),
                b: at(b_end),
                r: r_line,
            });
        }
    }
    let (w, h) = f.size;
    let mut r_plus = vec![false; w as usize * h as usize];
    let grow = 1.0 + std::f64::consts::SQRT_2;
    for sh in &shapes {
        let Shape::Capsule { a, b, r } = *sh;
        let rr = r + grow;
        let (x0, x1) = (
            (a.0.min(b.0) - rr).floor().max(0.0),
            (a.0.max(b.0) + rr).ceil().min(f64::from(w)),
        );
        let (y0, y1) = (
            (a.1.min(b.1) - rr).floor().max(0.0),
            (a.1.max(b.1) + rr).ceil().min(f64::from(h)),
        );
        let (mut y, x_start) = (y0, x0);
        while y < y1 {
            let mut x = x_start;
            while x < x1 {
                if dist((x + 0.5, y + 0.5), a, b) < rr {
                    r_plus[y as usize * w as usize + x as usize] = true;
                }
                x += 1.0;
            }
            y += 1.0;
        }
    }
    RefMasks {
        a: a_px,
        r_plus,
        shapes,
    }
}

/// Distance from p to the segment ab.
pub fn dist(p: (f64, f64), a: (f64, f64), b: (f64, f64)) -> f64 {
    let (abx, aby) = (b.0 - a.0, b.1 - a.1);
    let len2 = abx * abx + aby * aby;
    let t = if len2 > 0.0 {
        (((p.0 - a.0) * abx + (p.1 - a.1) * aby) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    let (qx, qy) = (a.0 + t * abx, a.1 + t * aby);
    ((p.0 - qx).powi(2) + (p.1 - qy).powi(2)).sqrt()
}
