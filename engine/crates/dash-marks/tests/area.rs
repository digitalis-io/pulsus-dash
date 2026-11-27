//! The line area on the GPU (#282 Part 2b §5; ADR-0036, T02-029), native on lavapipe, T1 and T2,
//! white on black, the line itself made invisible (a negative width covers nothing) unless the
//! test is about the strokes:
//!
//! - `area_crossing`: the fixture's joins in a 400-column plot: per column the first filled row is
//!   `area_pieces`' edge ±1 device px, and the f64 value-space class (Canvas 2D's) away from the
//!   boundaries; nothing outside the joins or the plot; T1 = T2.
//! - `area_span`, `area_gap`, `area_inner_gap`, `area_dot`: the area follows the line's joins.
//! - `area_order`: every area draw precedes every line draw (one batch, forced batches, deferred).
//! - `area_seam`: a flat dense line's area is uniform along a row.
//! - `area_cost`: one more draw per Line item, the same resources.
mod common;
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::sync::Arc;

use common::*;
use dash_gpu::{GpuContext, HeadlessTarget, Tier};
use dash_marks::line::{PassKind, Pending, Renderer, RendererOptions, Sync};
use dash_marks::{Area, DrawList, MarkItem};
use dash_scales::Range64;
use dash_scales::decimate::{INST_KIND_SHIFT, KIND_SEGMENT};
use dash_scene::{PieceClass, area_pieces, join_ends};
use dash_tokens::Rgba8;
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};

const W: u32 = 400;
const H: u32 = 400;
const PLOT: [f64; 4] = [0.0, 100.0, 400.0, 200.0];
const TOP: u32 = 100;
const BOTTOM: u32 = 300;

/// One series per (timestamps, values); a timestamp c + 0.5 lands in column c.
fn chunk(series: &[(Vec<f64>, Vec<f64>)]) -> Arc<Chunk> {
    let mut b = ChunkBuilder::explicit(ChunkId(0xa7ea));
    for (k, (ts, vs)) in series.iter().enumerate() {
        let meta = SeriesMeta {
            key_hash: k as u64 + 1,
            labels: Vec::new().into(),
        };
        ok(b.push_series(meta, Some(ts), vs), "series");
    }
    Arc::new(b.finish())
}

/// The draw list of `chunk` on the 400-column plot under `axis`, with the area and line width.
fn list(chunk: Arc<Chunk>, axis: Range64, area: Option<f32>, width: f32) -> DrawList {
    let mut l = line_list(chunk, (400.0, 400.0), 1.0, PLOT, (0.0, 400.0), axis, false);
    for i in &mut l.items {
        if let MarkItem::Line {
            area: a,
            width_css,
            ..
        } = i
        {
            *a = area.map(|alpha_top| Area { alpha_top });
            *width_css = width;
        }
    }
    l
}

fn renderer(ctx: &GpuContext, max_instances: Option<u64>, sync: Sync) -> Renderer {
    Renderer::new(
        ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions {
            max_instances,
            sync,
        },
    )
}

struct Img(Vec<u8>);

impl Img {
    fn px(&self, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * W + x) * 4) as usize;
        [self.0[i], self.0[i + 1], self.0[i + 2], self.0[i + 3]]
    }
    fn filled(&self, x: u32, y: u32) -> bool {
        self.px(x, y)[0] > 0
    }
    /// The first filled row of column x inside the plot.
    fn first(&self, x: u32) -> Option<u32> {
        (TOP..BOTTOM).find(|y| self.filled(x, *y))
    }
}

fn draw(ctx: &GpuContext, l: &DrawList) -> (Img, Renderer) {
    let mut r = renderer(ctx, None, Sync::Block);
    let (px, _) = render(ctx, &mut r, l);
    (Img(px), r)
}

fn both(l: &DrawList) -> Img {
    let (a, _) = draw(&ctx(Tier::T1), l);
    let (b, _) = draw(&ctx(Tier::T2), l);
    assert!(a.0 == b.0, "T1 and T2 differ");
    a
}

/// The expected first filled row at the centre of column x for a piece class and its edge y.
fn row_of(class: PieceClass, y: f64) -> Option<u32> {
    match class {
        PieceClass::Above => Some(TOP),
        PieceClass::Inside => Some(((y - 0.5).ceil().max(f64::from(TOP))) as u32),
        PieceClass::Below => None,
    }
    .filter(|r| *r < BOTTOM)
}

fn near(got: Option<u32>, want: Option<u32>) -> bool {
    match (got, want) {
        (None, None) => true,
        (Some(g), Some(w)) => g.abs_diff(w) <= 1,
        (Some(g), None) | (None, Some(g)) => g + 1 >= BOTTOM,
    }
}

#[test]
fn area_crossing() {
    let rows = fixture::load("area-pieces.json");
    assert!(!rows.is_empty(), "area-pieces.json");
    for row in &rows {
        let id = row["case"].as_str().unwrap_or_default();
        let n = |k: &str| fixture::num(&row[k]);
        let col = |x: f64| (x * 4.0).min(399.0);
        let (c0, c1) = (col(n("x0")), col(n("x1")));
        let (va, vb, min, max) = (n("va"), n("vb"), n("min"), n("max"));
        let ch = chunk(&[(vec![c0 + 0.5, c1 + 0.5], vec![va, vb])]);
        let l = list(ch, Range64 { lo: min, hi: max }, Some(1.0), -2.0);
        let img = both(&l);
        let (_, r) = draw(&ctx(Tier::T2), &l);
        let Some(dec) = r.read_decimation(&ctx(Tier::T2)) else {
            panic!("{id}: no decimation")
        };
        let Some(MarkItem::Line { axis, .. }) = l.items.iter().find(|i| matches!(i, MarkItem::Line { .. })) else {
            panic!("{id}: no Line item")
        };
        let plot = PLOT.map(|v| v as f32);
        let mut pieces = Vec::new();
        for i in &dec.instances {
            if (i.meta >> INST_KIND_SHIFT) & 3 != KIND_SEGMENT {
                continue;
            }
            if let Some((x0, x1, a, b)) = join_ends(i.col, i.va, i.vb, i.meta, plot, *axis) {
                pieces.extend(area_pieces(x0, x1, a, b, TOP as f32, BOTTOM as f32));
            }
        }
        // The f64 line in value space (Canvas 2D's classes).
        let (x0, x1) = (c0 + 0.5, c1 + 0.5);
        let value = |x: f64| {
            let t = (x - x0) / (x1 - x0);
            va * (1.0 - t) + vb * t
        };
        let class64 = |x: f64| {
            let v = value(x);
            if v > max {
                PieceClass::Above
            } else if v < min {
                PieceClass::Below
            } else {
                PieceClass::Inside
            }
        };
        let y64 = |x: f64| {
            let f = (value(x) - min) / (max - min);
            100.0 + (1.0 - f) * 200.0
        };
        for x in 0..W {
            let cx = f64::from(x) + 0.5;
            let got = img.first(x);
            if !(cx >= x0 && cx < x1) {
                assert!(got.is_none(), "{id}: column {x} outside the join is filled");
                continue;
            }
            let at = pieces
                .iter()
                .find(|p| f64::from(p.x0) <= cx && cx < f64::from(p.x1));
            let Some(p) = at else {
                panic!("{id}: no piece at column {x}")
            };
            let boundary = |b: f32| (f64::from(b) - cx).abs() <= 1.0;
            if (boundary(p.x0) && f64::from(p.x0) > x0) || (boundary(p.x1) && f64::from(p.x1) < x1)
            {
                continue;
            }
            let t = (cx as f32 - p.x0) / (p.x1 - p.x0).max(f32::MIN_POSITIVE);
            let want = row_of(p.class, f64::from(p.y0 + t * (p.y1 - p.y0)));
            assert!(near(got, want), "{id}: column {x}: first row {got:?}, pieces {want:?}");
            if [cx - 1.0, cx, cx + 1.0].iter().all(|v| class64(*v) == class64(cx)) {
                let want64 = row_of(class64(cx), y64(cx));
                assert!(near(got, want64), "{id}: column {x}: {got:?}, Canvas 2D {want64:?}");
            }
        }
        for y in (0..TOP).chain(BOTTOM..H) {
            assert!((0..W).all(|x| !img.filled(x, y)), "{id}: row {y} outside the plot");
        }
    }
}

const AXIS: Range64 = Range64 { lo: 0.0, hi: 100.0 };

/// One sample per column in `cols`, at `v(c)`.
fn samples(cols: impl Iterator<Item = u32>, v: impl Fn(u32) -> f64) -> (Vec<f64>, Vec<f64>) {
    cols.map(|c| (f64::from(c) + 0.5, v(c))).unzip()
}

#[test]
fn area_span() {
    let ch = chunk(&[samples(100..=300, |c| 40.0 + f64::from(c % 7))]);
    let img = both(&list(ch, AXIS, Some(1.0), -2.0));
    for x in (0..100).chain(301..W) {
        assert!((TOP..BOTTOM).all(|y| !img.filled(x, y)), "column {x}");
    }
    assert!(img.filled(200, 290), "column 200");
}

#[test]
fn area_gap() {
    let ch = chunk(&[samples(0..W, |c| {
        if (180..=220).contains(&c) {
            f64::NAN
        } else {
            50.0
        }
    })]);
    let img = both(&list(ch, AXIS, Some(1.0), -2.0));
    for x in 181..=219 {
        assert!((TOP..BOTTOM).all(|y| !img.filled(x, y)), "column {x}");
    }
    assert!(img.filled(150, 290) && img.filled(250, 290));
}

#[test]
fn area_inner_gap() {
    let ts = vec![100.5, 200.1, 200.5, 200.9, 300.5];
    let vs = vec![30.0, 60.0, f64::NAN, 40.0, 50.0];
    let l = list(chunk(&[(ts, vs)]), AXIS, Some(1.0), -2.0);
    let img = both(&l);
    assert!(img.filled(150, 290) && img.filled(250, 290));
    // The joins 100 → 200.first and 200.last → 300 (no join inside column 200).
    let (_, r) = draw(&ctx(Tier::T2), &l);
    let Some(dec) = r.read_decimation(&ctx(Tier::T2)) else {
        panic!("no decimation")
    };
    let segments = dec
        .instances
        .iter()
        .filter(|i| (i.meta >> INST_KIND_SHIFT) & 3 == KIND_SEGMENT && i.col >> 16 > 0)
        .count();
    assert_eq!(segments, 2);
    // 100 → 200.first (60) ends higher than 200.last (40) → 300 starts.
    let (a, b) = (img.first(199), img.first(201));
    assert!(a.zip(b).is_some_and(|(a, b)| a + 10 < b), "{a:?} {b:?}");
}

#[test]
fn area_dot() {
    let lone = chunk(&[samples([200].into_iter(), |_| 50.0)]);
    let img = both(&list(lone, AXIS, Some(1.0), -2.0));
    assert!(img.0.chunks(4).all(|p| p[0] == 0), "a lone sample has no area");
    let pair = chunk(&[samples([100, 151].into_iter(), |_| 50.0)]);
    let img = both(&list(pair, AXIS, Some(1.0), -2.0));
    assert!((101..=150).all(|x| img.filled(x, 290)), "one span across the empty columns");
}

const RED: Rgba8 = Rgba8([255, 0, 0, 255]);
const GREEN: Rgba8 = Rgba8([0, 255, 0, 255]);

/// Series 1 (red) flat at 50 inside series 2's (green, flat at 90) area.
fn order_list() -> DrawList {
    let ch = chunk(&[
        samples(0..W, |_| 50.0),
        samples(0..W, |_| 90.0),
    ]);
    let mut l = list(ch, AXIS, Some(1.0), 4.0);
    l.palette[0] = RED;
    l.palette[1] = GREEN;
    l
}

fn assert_order(r: &Renderer, img: &Img, what: &str) {
    let passes = r.last_passes();
    assert_eq!(passes.first(), Some(&PassKind::Area), "{what}: {passes:?}");
    assert!(
        passes.iter().skip(1).all(|p| *p != PassKind::Area),
        "{what}: {passes:?}"
    );
    assert_eq!(img.px(200, 199), RED.0, "{what}: series 1's stroke");
}

#[test]
fn area_order() {
    let l = order_list();
    for tier in [Tier::T1, Tier::T2] {
        let ctx = ctx(tier);
        for cap in [None, Some(1)] {
            let mut r = renderer(&ctx, cap, Sync::Block);
            let (px, _) = render(&ctx, &mut r, &l);
            assert_order(&r, &Img(px), &format!("{tier:?} {cap:?}"));
        }
    }
    let ctx = ctx(Tier::T1);
    let mut r = renderer(&ctx, None, Sync::Defer);
    let mut t = HeadlessTarget::new(&ctx, W, H);
    assert_eq!(r.render(&ctx, &l, &mut t), None);
    assert!(ctx.device.poll(wgpu::PollType::wait_indefinitely()).is_ok());
    assert!(matches!(r.poll(), Pending::Complete(_)));
    assert_order(&r, &Img(t.read(&ctx)), "deferred T1");
}

#[test]
fn area_seam() {
    let ch = chunk(&[samples(50..350, |_| 50.0)]);
    let img = both(&list(ch, AXIS, Some(0.5), -2.0));
    let row = 250;
    let p0 = img.px(60, row);
    assert!(p0[0] > 0);
    for x in 60..340 {
        assert_eq!(img.px(x, row), p0, "column {x}");
    }
}

#[test]
fn area_cost() {
    let ch = chunk(&[samples(0..W, |c| f64::from(c % 50))]);
    for tier in [Tier::T1, Tier::T2] {
        let ctx = ctx(tier);
        let (_, off) = draw(&ctx, &list(ch.clone(), AXIS, None, 1.5));
        let (_, on) = draw(&ctx, &list(ch.clone(), AXIS, Some(0.18), 1.5));
        assert_eq!(on.last_draws(), off.last_draws() + 1, "{tier:?}");
        assert_eq!(on.debug_counters(), off.debug_counters(), "{tier:?}");
    }
}
