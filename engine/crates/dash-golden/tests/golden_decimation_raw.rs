//! golden:decimation-raw (plan #68 A.15.2, the VIZ-006 gate; T02-015): the decimated render and a
//! render of every raw sample through the same line pipeline have exactly the same coverage, on
//! T1 and T2 at DPR 1 and 2. The raw list is built here from the samples, without `decimate`,
//! `ColumnRanges` or any engine pass.
mod common;

use common::*;
use dash_golden::{Image, device_size};
use dash_gpu::{HeadlessTarget, Tier};
use dash_marks::MarkItem;
use dash_marks::desc::DrawList;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scales::decimate::LineInstance;
use dash_scales::encode::{Encoding, U_CLAMP};
use dash_wire::{Chunk, TimeAxis};
use pulsus_synth::reference::{RefFixture, WINDOW, f1a, f1b, f2, f3, f4a, f5, f6};

const SPAN: u32 = 1 << 4;
const DOT: u32 = 2 << 4;
const ROUND: u32 = (1 << 6) | (1 << 7);

/// Cut parameter of bound `c` along the value from `va` to `vb` (A.4 rule).
fn cut(c: f64, va: f64, vb: f64) -> f64 {
    if (vb - va).is_finite() { (c - va) / (vb - va) } else { (c / 2.0 - va / 2.0) / (vb / 2.0 - va / 2.0) }
}

fn col_of(t: f64, n: u32) -> Option<u32> {
    let (from, to) = WINDOW;
    if !(t >= from && t <= to) {
        return None;
    }
    Some((((t - from) / (to - from)) * f64::from(n)).floor().clamp(0.0, f64::from(n - 1)) as u32)
}

/// Every raw sample: a capsule per consecutive finite pair (vertical inside a column), a dot per
/// finite sample joined on neither side; far values cut at the encoding's clip box in f64.
fn raw_instances(chunk: &Chunk, enc: &Encoding, n: u32) -> Vec<LineInstance> {
    let u = |v: f64| f32::from_bits(enc.encode(v));
    let b = enc.clip_box();
    let mut out = Vec::new();
    for s in 0..chunk.series.len() {
        let (lo, hi) = (chunk.offsets[s] as usize, chunk.offsets[s + 1] as usize);
        let mut samples: Vec<(u32, f64, bool)> = Vec::new();
        let mut gap = false;
        for k in lo..hi {
            let t = match &chunk.time {
                TimeAxis::Grid { start_ms, step_ms, .. } => (start_ms + step_ms * (k - lo) as i64) as f64,
                TimeAxis::Explicit { t_ms } => t_ms[k],
            };
            let Some(c) = col_of(t, n) else { continue };
            let v = chunk.values[k];
            if !v.is_finite() {
                gap = true;
                continue;
            }
            samples.push((c, v, gap));
            gap = false;
        }
        let slot = (s % 8) as u32;
        for k in 0..samples.len() {
            let (c, v, gap_before) = samples[k];
            let left = k > 0 && !gap_before;
            let right = k + 1 < samples.len() && !samples[k + 1].2;
            if !left && !right {
                out.push(LineInstance { col: c, va: u(v), vb: u(v), meta: slot | DOT | ROUND });
            }
            if !right {
                continue;
            }
            let (c2, v2, _) = samples[k + 1];
            if c2 == c {
                out.push(LineInstance { col: c, va: u(v), vb: u(v2), meta: slot | SPAN | ROUND });
                continue;
            }
            let col = c2 | ((c2 - c) << 16);
            let side = |x: f64| if x < b.lo { Some((b.lo, 1u32)) } else if x > b.hi { Some((b.hi, 2u32)) } else { None };
            let (mut va, mut vb, mut meta) = (u(v), u(v2), slot | ROUND);
            match (side(v), side(v2)) {
                (Some((_, sa)), Some((_, sb))) if sa == sb => {
                    // Wholly beyond one side: an invisible capsule at t = 0 and 1.
                    va = 0.0;
                    vb = 1.0;
                    meta |= (sa << 8) | (sa << 10);
                }
                (ca, cb) => {
                    if let Some((c0, sa)) = ca {
                        va = cut(c0, v, v2) as f32;
                        meta |= sa << 8;
                    }
                    if let Some((c1, sb)) = cb {
                        vb = cut(c1, v, v2) as f32;
                        meta |= sb << 10;
                    }
                }
            }
            out.push(LineInstance { col, va, vb, meta });
        }
    }
    let _ = U_CLAMP;
    out
}

fn raw_render(ctx: &dash_gpu::GpuContext, list: &DrawList, raw: &[LineInstance]) -> Image {
    let (w, h) = device_size(list.css, list.dpr);
    let mut t = HeadlessTarget::new(ctx, w, h);
    let mut r = Renderer::new(ctx, wgpu::TextureFormat::Rgba8Unorm, RendererOptions::default());
    r.render_instances(ctx, list, raw, &mut t);
    Image { w, h, rgba: t.read(ctx) }
}

fn mask_diff(a: &Image, b: &Image) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for y in 0..a.h {
        for x in 0..a.w {
            if a.covered(x, y) != b.covered(x, y) {
                out.push((x, y));
            }
        }
    }
    out
}

fn run(fixtures: &[RefFixture]) {
    let (t1, t2) = (ctx(Tier::T1), ctx(Tier::T2));
    for fx in fixtures {
        for dpr in [1.0f32, 2.0] {
            let list = list_of(fx, dpr);
            let Some(MarkItem::Line { encoding, n, .. }) = list.items.first() else {
                panic!("{}: no line item", fx.name);
            };
            let raw = raw_instances(&fx.chunk, encoding, *n);
            let reference = raw_render(&t1, &list, &raw);
            assert!(reference.rgba.iter().step_by(4).any(|r| *r > 0), "{} @{dpr}: empty raw render", fx.name);
            if fx.name == "F5" {
                let f = frame_of(fx, dpr);
                let d = f64::from(dpr);
                let px = |x: f64, v: f64| ((x * d).floor() as u32, (f.y(v) * d).floor() as u32);
                let (x5, y5) = px(PLOT[0] + 500.5, 0.5);
                let (x3, y3) = px(PLOT[0] + 500.5, 0.3);
                assert!(reference.covered(x5, y5), "F5 @{dpr}: raw misses the first-sample join");
                assert!(!reference.covered(x3, y3), "F5 @{dpr}: raw covers the last → last join");
            }
            for (tier, ctx) in [(Tier::T1, &t1), (Tier::T2, &t2)] {
                let img = render(ctx, &list);
                let diff = mask_diff(&img, &reference);
                assert!(diff.is_empty(), "{} @{dpr} {tier:?}: {} pixels differ, first {:?}", fx.name, diff.len(), &diff[..diff.len().min(8)]);
            }
        }
    }
}

#[test]
fn golden_decimation_raw() {
    run(&[
        ok(f1a(100, 10_000), "F1a"),
        ok(f1b(), "F1b"),
        ok(f2(100, 10_000), "F2"),
        ok(f3(), "F3"),
        ok(f4a(), "F4a"),
        ok(f5(), "F5"),
        ok(f6(), "F6"),
    ]);
}

/// Nightly volume: F1c, 1 000 series × 10⁵ grid points (10⁸).
#[test]
#[ignore]
fn golden_decimation_raw_full() {
    run(&[ok(f1a(1000, 100_000), "F1c")]);
}
