//! The selection on the engine line (plan #68 C2c2 §5; T25-006, ADR-0025 decision 4, ADR-0032,
//! T02-029), native on lavapipe, T1 and T2:
//!
//! - `selection_passes`: `S3`'s three series at 800×240 with a2 selected: (a) a1 dimmed, a2 at its
//!   colour over a `focus` underlay, the guides unchanged; (b) no emphasis draws C2c1's image; (c)
//!   three forced batches draw the one-batch image; (d) T1 = T2; (e) a1 and a2 selected: a2's
//!   underlay over a1's line where they cross, and the logged passes in Canvas 2D's order
//!   (`selection.json`'s crossing case).
//! - `dim_density`: unmatched series at 1, 5 and 1.3 samples per column, two crossing, are dimmed
//!   together: one composite of their full-alpha image at `dimmed`, joints and crossings included.
//! - `dim_layer_lifecycle`: the dim layer follows the target size, goes with the selection and is
//!   made again on a new renderer; every image equals a fresh renderer's.
mod common;
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::sync::Arc;

use common::*;
use dash_gpu::{GpuContext, Tier};
use dash_marks::line::{PassKind, Renderer, RendererOptions};
use dash_marks::{DrawList, MarkItem};
use dash_scene::{
    Band, Built, Camera, PlotCamera, Range64, SelectionIn, Size64, Theme, Viewport, VisSpec,
    build_frame,
};
use dash_tokens::{ColourRole, Rgba8, colour};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};

/// A value function of a series.
type ValueFn = fn(f64) -> f64;

const T0: f64 = 1_795_089_600_000.0;
const T1: f64 = T0 + 3_600_000.0;
const A1: &str = "00000000000000a1";
const A2: &str = "00000000000000a2";
const LINE: &str = r#"{"kind":"line","title":"T","unit":{"kind":"none"}}"#;
/// FNV-1a of the C2c1 render of `S3` at 800×240, dark, no selection (T1, T2), on the pinned Mesa;
/// #282 Part 2b: the `chart-grid` guides and the `chart-axis` baseline.
const C2C1_S3: [u64; 2] = [0x31d1_6088_e372_1374, 0x31d1_6088_e372_1374];

struct Image {
    w: u32,
    px: Vec<u8>,
}

impl Image {
    fn at(&self, x: u32, y: u32) -> [u8; 3] {
        let i = ((y * self.w + x) * 4) as usize;
        [self.px[i], self.px[i + 1], self.px[i + 2]]
    }
}

fn fnv(b: &[u8]) -> u64 {
    b.iter().fold(0xcbf2_9ce4_8422_2325, |h, x| {
        (h ^ u64::from(*x)).wrapping_mul(0x100_0000_01b3)
    })
}

fn spec(json: &str) -> VisSpec {
    match VisSpec::from_json(json) {
        Ok(s) => s,
        Err(e) => panic!("spec: {e}"),
    }
}

/// `S3`: 61 samples over 12:00–13:00; a1 `30·i/60`, a2 `30 − 30·i/60`, a3 10.
fn s3() -> Arc<Chunk> {
    let t: Vec<f64> = (0..61).map(|i| T0 + f64::from(i) * 60_000.0).collect();
    let f: [(u64, ValueFn); 3] = [
        (0xa1, |i| 30.0 * i / 60.0),
        (0xa2, |i| 30.0 - 30.0 * i / 60.0),
        (0xa3, |_| 10.0),
    ];
    let mut b = ChunkBuilder::explicit(ChunkId(0xc2c2));
    for (key, v) in f {
        let vs: Vec<f64> = (0..61).map(|i| v(f64::from(i))).collect();
        let meta = SeriesMeta {
            key_hash: key,
            labels: Vec::new().into(),
        };
        assert!(b.push_series(meta, Some(&t), &vs).is_ok());
    }
    Arc::new(b.finish())
}

fn viewport(
    chunk: &Arc<Chunk>,
    css: (f64, f64),
    theme: Theme,
    json: &str,
    sel: SelectionIn,
) -> Viewport {
    let spec = spec(json);
    Viewport {
        id: 1,
        frame_id: None,
        css: Size64 { w: css.0, h: css.1 },
        dpr: 1.0,
        theme,
        camera: Camera::Plot2D(PlotCamera::idle(Range64 { lo: T0, hi: T1 }, &spec)),
        spec,
        data: Some(chunk.clone()),
        band: Band::Measure,
        events: Arc::from([]),
        selection: Arc::new(sel),
        fit: None,
        fade: None,
    }
}

fn keys(k: &[&str]) -> SelectionIn {
    SelectionIn::new(k.iter().copied(), None, None)
}

fn draw(ctx: &GpuContext, opts: RendererOptions, list: &DrawList) -> (Image, Renderer) {
    let mut r = Renderer::new(ctx, wgpu::TextureFormat::Rgba8Unorm, opts);
    let (px, _) = render(ctx, &mut r, list);
    let (w, _) = device_size(list.css, list.dpr);
    (Image { w, px }, r)
}

fn fresh(ctx: &GpuContext, list: &DrawList) -> Image {
    draw(ctx, RendererOptions::default(), list).0
}

/// The palette colour of series `s` of the list's Line item.
fn series_colour(list: &DrawList, s: usize) -> Rgba8 {
    let slot = list
        .items
        .iter()
        .find_map(|i| match i {
            MarkItem::Line { colour_slots, .. } => colour_slots.get(s).copied(),
            _ => None,
        })
        .unwrap_or_else(|| panic!("no Line item"));
    list.palette[usize::from(slot)]
}

fn rgb(c: Rgba8) -> [u8; 3] {
    [c.0[0], c.0[1], c.0[2]]
}

/// `bg + (c − bg)·a`, rounded.
fn blend(bg: [u8; 3], c: [u8; 3], a: f64) -> [u8; 3] {
    [0, 1, 2].map(|k| {
        let (b, v) = (f64::from(bg[k]), f64::from(c[k]));
        (b + (v - b) * a).round() as u8
    })
}

fn near(a: [u8; 3], b: [u8; 3], tol: u8) -> bool {
    (0..3).all(|k| a[k].abs_diff(b[k]) <= tol)
}

/// The guide rows (device px, DPR 1), widened by one row each side.
fn guide_rows(list: &DrawList) -> Vec<u32> {
    let mut out = Vec::new();
    for i in &list.items {
        if let MarkItem::Guides { lines, .. } = i {
            for y in lines {
                let r = y.round() as i64;
                out.extend((r - 1..=r + 1).filter(|v| *v >= 0).map(|v| v as u32));
            }
        }
    }
    out
}

/// Value `v`'s y (CSS = device px at DPR 1) on a build's axis.
fn y_of(b: &Built, v: f64) -> f64 {
    let Some(p) = b.pick.as_ref() else {
        panic!("no pick")
    };
    p.axis.y(v)
}

fn plot_of(b: &Built) -> [f64; 4] {
    let Some(s) = b.stage.as_ref() else {
        panic!("no stage")
    };
    [s.plot.x, s.plot.y, s.plot.width, s.plot.height]
}

/// A full-coverage pixel of `c` in `img` near (column of fraction `f`, row `y`), off `skip` rows.
fn full_pixel(
    img: &Image,
    b: &Built,
    f: f64,
    y: f64,
    c: [u8; 3],
    skip: &[u32],
) -> Option<(u32, u32)> {
    let p = plot_of(b);
    let cx = (p[0] + f * p[2]).floor() as i64;
    for dx in [0i64, 1, -1, 2, -2] {
        for dy in -3i64..=3 {
            let (x, yy) = ((cx + dx) as u32, (y.floor() as i64 + dy) as u32);
            if !skip.contains(&yy) && img.at(x, yy) == c {
                return Some((x, yy));
            }
        }
    }
    None
}

/// The mean ꟻLIP of `b` against `a` (default pixels per degree).
fn flip_mean(a: &Image, b: &Image, h: u32) -> f32 {
    let rgb = |i: &Image| -> Vec<u8> {
        i.px.as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| [p[0], p[1], p[2]])
            .collect()
    };
    let r = nv_flip::FlipImageRgb8::with_data(a.w, h, &rgb(a));
    let t = nv_flip::FlipImageRgb8::with_data(b.w, h, &rgb(b));
    let m = nv_flip::flip(r, t, nv_flip::DEFAULT_PIXELS_PER_DEGREE).to_vec();
    m.iter().sum::<f32>() / m.len() as f32
}

#[test]
fn selection_passes() {
    let chunk = s3();
    let mut tiers = Vec::new();
    let mut failures = Vec::new();
    for (k, tier) in [Tier::T1, Tier::T2].into_iter().enumerate() {
        let ctx = ctx(tier);
        let plain_b = build_frame(&viewport(
            &chunk,
            (800.0, 240.0),
            Theme::Dark,
            LINE,
            SelectionIn::default(),
        ));
        let sel_b = build_frame(&viewport(
            &chunk,
            (800.0, 240.0),
            Theme::Dark,
            LINE,
            keys(&[A2]),
        ));
        let (plain, sel) = (fresh(&ctx, &plain_b.list), fresh(&ctx, &sel_b.list));
        let bg = rgb(plain_b.list.clear);
        let (a1, a2) = (
            rgb(series_colour(&plain_b.list, 0)),
            rgb(series_colour(&plain_b.list, 1)),
        );
        let focus = rgb(colour(Theme::Dark, ColourRole::Focus));
        let guides = guide_rows(&plain_b.list);
        // (a) Mid-segment (15.5/60): a1 dimmed, a2 at its colour, its underlay beside it.
        let f = 15.5 / 60.0;
        let Some((x1, y1)) = full_pixel(&plain, &plain_b, f, y_of(&plain_b, 30.0 * f), a1, &guides)
        else {
            panic!("{tier:?}: no full a1 pixel")
        };
        let want = blend(bg, a1, 0.35);
        if !near(sel.at(x1, y1), want, 2) {
            failures.push(format!(
                "{tier:?} (a): a1 at ({x1}, {y1}) = {:?}, want {want:?}",
                sel.at(x1, y1)
            ));
        }
        let ya2 = y_of(&plain_b, 30.0 - 30.0 * f);
        let Some((x2, y2)) = full_pixel(&plain, &plain_b, f, ya2, a2, &guides) else {
            panic!("{tier:?}: no full a2 pixel")
        };
        if !near(sel.at(x2, y2), a2, 2) {
            failures.push(format!(
                "{tier:?} (a): a2 at ({x2}, {y2}) = {:?}",
                sel.at(x2, y2)
            ));
        }
        let beside: Vec<u32> = (0..240u32)
            .filter(|r| (1.5..=2.5).contains(&(f64::from(*r) + 0.5 - ya2).abs()))
            .collect();
        if !beside.iter().any(|r| near(sel.at(x2, *r), focus, 2)) {
            let got: Vec<[u8; 3]> = beside.iter().map(|r| sel.at(x2, *r)).collect();
            failures.push(format!(
                "{tier:?} (a): no focus beside a2 at x {x2}: {got:?}"
            ));
        }
        // Guides at full `hairline`: every guide-only pixel of each guide row (the row's most
        // common colour in the plain render) is unchanged.
        let p = plot_of(&plain_b);
        for i in &plain_b.list.items {
            if let MarkItem::Guides { lines, .. } = i {
                for y in lines {
                    let gy = y.round() as u32;
                    let cols = (p[0].ceil() as u32)..((p[0] + p[2]).floor() as u32);
                    let mut counts = std::collections::BTreeMap::new();
                    for x in cols.clone() {
                        *counts.entry(plain.at(x, gy)).or_insert(0u32) += 1;
                    }
                    let Some((guide, _)) = counts.iter().max_by_key(|(_, n)| **n) else {
                        continue;
                    };
                    // A series lying on the row (a3 at 10) is not a guide-only pixel.
                    if !near(*guide, bg, 30) {
                        continue;
                    }
                    // Off a2's underlay (5.5 px wide, over the guides).
                    let off_a2 = |x: u32| {
                        let fx = (f64::from(x) + 0.5 - p[0]) / p[2];
                        let ya = y_of(&plain_b, 30.0 - 30.0 * fx);
                        (f64::from(gy) + 0.5 - ya).abs() > 4.0
                    };
                    let changed = cols
                        .filter(|x| {
                            off_a2(*x)
                                && plain.at(*x, gy) == *guide
                                && !near(sel.at(*x, gy), *guide, 2)
                        })
                        .count();
                    if changed > 0 {
                        failures.push(format!(
                            "{tier:?} (a): guide row {gy}: {changed} pixels changed"
                        ));
                    }
                }
            }
        }
        // (b) No emphasis: C2c1's image, bit for bit.
        let foreign_b = build_frame(&viewport(
            &chunk,
            (800.0, 240.0),
            Theme::Dark,
            LINE,
            keys(&["00000000000000ff"]),
        ));
        if fresh(&ctx, &foreign_b.list).px != plain.px {
            failures.push(format!("{tier:?} (b): a foreign key changed the image"));
        }
        let h = fnv(&plain.px);
        if h != C2C1_S3[k] {
            failures.push(format!(
                "{tier:?} (b): FNV {h:#018x}, C2c1 {:#018x}",
                C2C1_S3[k]
            ));
        }
        // (c) Three forced batches draw the one-batch image.
        let (_, r) = draw(&ctx, RendererOptions::default(), &sel_b.list);
        let lines: usize = sel_b
            .list
            .items
            .iter()
            .map(|i| match i {
                MarkItem::Guides { lines, .. } => lines.len(),
                _ => 0,
            })
            .sum();
        let all = r.last_total().unwrap_or(0) + lines as u64;
        let opts = RendererOptions {
            max_instances: Some(all.div_ceil(3)),
            ..RendererOptions::default()
        };
        let (batched, rb) = draw(&ctx, opts, &sel_b.list);
        if rb.last_draws() < 3 {
            failures.push(format!("{tier:?} (c): {} draws", rb.last_draws()));
        }
        if batched.px != sel.px {
            failures.push(format!("{tier:?} (c): the batched image differs"));
        }
        // (e) a1 and a2: a2's underlay over a1's line beside the crossing; Canvas 2D's order.
        let both_b = build_frame(&viewport(
            &chunk,
            (800.0, 240.0),
            Theme::Dark,
            LINE,
            keys(&[A1, A2]),
        ));
        let (both, rr) = draw(&ctx, RendererOptions::default(), &both_b.list);
        let mut checked = 0;
        for c in 0..800u32 {
            let fx = (f64::from(c) + 0.5 - p[0]) / p[2];
            if !(0.4..=0.6).contains(&fx) {
                continue;
            }
            let (ya, yb) = (y_of(&both_b, 30.0 * fx), y_of(&both_b, 30.0 - 30.0 * fx));
            for r in 0..240u32 {
                let rc = f64::from(r) + 0.5;
                if (rc - ya).abs() <= 0.75 && (1.4..=2.2).contains(&(rc - yb).abs()) {
                    checked += 1;
                    if !near(both.at(c, r), focus, 2) {
                        failures.push(format!(
                            "{tier:?} (e): ({c}, {r}) = {:?}, not focus",
                            both.at(c, r)
                        ));
                    }
                }
            }
        }
        if checked < 2 {
            failures.push(format!("{tier:?} (e): {checked} pixels checked"));
        }
        let passes = rr.last_passes();
        let want = [
            PassKind::A1,
            PassKind::A2,
            PassKind::A3,
            PassKind::B(1),
            PassKind::C(1),
            PassKind::B(2),
            PassKind::C(2),
        ];
        if passes != want {
            failures.push(format!("{tier:?} (e): passes {passes:?}"));
        }
        let shown = ["00000000000000a1", A2, "00000000000000a3"];
        let matched = [A1, A2];
        let order: Vec<(String, String)> = passes
            .iter()
            .flat_map(|p| match p {
                PassKind::A2 => shown
                    .iter()
                    .filter(|k| !matched.contains(k))
                    .map(|k| ((*k).to_owned(), "dimmed".to_owned()))
                    .collect(),
                PassKind::B(r) => {
                    vec![(matched[*r as usize - 1].to_owned(), "underlay".to_owned())]
                }
                PassKind::C(r) => vec![(matched[*r as usize - 1].to_owned(), "line".to_owned())],
                _ => Vec::new(),
            })
            .collect();
        let rows = fixture::load("selection.json");
        let Some(row) = rows.iter().find(|r| r["case"] == "crossing") else {
            panic!("selection.json: no crossing case")
        };
        let recorded: Vec<(String, String)> = row["order"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|e| {
                (
                    e[0].as_str().unwrap_or_default().to_owned(),
                    e[1].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        if order != recorded {
            failures.push(format!(
                "{tier:?} (e): order {order:?}, Canvas 2D {recorded:?}"
            ));
        }
        tiers.push(sel);
    }
    // (d) T1 = T2.
    let m = flip_mean(&tiers[0], &tiers[1], 240);
    if m.is_nan() || m > 0.001 {
        failures.push(format!("(d): T1 vs T2 mean FLIP {m}"));
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

/// Four series over 1118×240 on a pinned axis 0..100: unmatched at 1, 5 and 1.3 samples per
/// column (the first two crossing), and a matched one at 150, above the plot (clipped away).
fn density() -> Arc<Chunk> {
    let mut b = ChunkBuilder::explicit(ChunkId(0xd1));
    let series: [(u64, u32, ValueFn); 4] = [
        (0xb1, 1_090, |f| 20.0 + 60.0 * f),
        (0xb2, 5_450, |f| 80.0 - 60.0 * f + 4.0 * (f * 9_000.0).sin()),
        (0xb3, 1_417, |f| 50.0 + 30.0 * (f * 40.0).sin()),
        (0xb4, 61, |_| 150.0),
    ];
    for (key, n, v) in series {
        let t: Vec<f64> = (0..n)
            .map(|i| T0 + (T1 - T0) * f64::from(i) / f64::from(n - 1))
            .collect();
        let vs: Vec<f64> = (0..n).map(|i| v(f64::from(i) / f64::from(n - 1))).collect();
        let meta = SeriesMeta {
            key_hash: key,
            labels: Vec::new().into(),
        };
        assert!(b.push_series(meta, Some(&t), &vs).is_ok());
    }
    Arc::new(b.finish())
}

const PINNED: &str =
    r#"{"kind":"line","title":"T","unit":{"kind":"none"},"valueRange":{"min":0,"max":100}}"#;

/// The unmatched series alone: no guides, the Line item's first three series, no emphasis.
fn alone(list: &DrawList) -> DrawList {
    let mut l = list.clone();
    l.items.retain(|i| !matches!(i, MarkItem::Guides { .. }));
    for i in &mut l.items {
        if let MarkItem::Line {
            series,
            colour_slots,
            emphasis,
            ..
        } = i
        {
            *series = 0..3;
            colour_slots.truncate(3);
            *emphasis = None;
        }
    }
    l
}

#[test]
fn dim_density() {
    let chunk = density();
    let mut failures = Vec::new();
    for tier in [Tier::T1, Tier::T2] {
        let ctx = ctx(tier);
        for theme in [Theme::Dark, Theme::Light] {
            let b = build_frame(&viewport(
                &chunk,
                (1118.0, 240.0),
                theme,
                PINNED,
                keys(&["00000000000000b4"]),
            ));
            let l = fresh(&ctx, &alone(&b.list));
            let r2 = fresh(&ctx, &b.list);
            let bg = rgb(b.list.clear);
            let skip = guide_rows(&b.list);
            let (mut worst, mut at) = (0u8, (0, 0));
            let (mut sum, mut n) = (0.0, 0u32);
            for y in (0..240u32).filter(|y| !skip.contains(y)) {
                for x in 0..1118u32 {
                    let (lv, rv) = (l.at(x, y), r2.at(x, y));
                    let want = blend(bg, lv, 0.35);
                    let d = (0..3).map(|k| rv[k].abs_diff(want[k])).max().unwrap_or(0);
                    if d > worst {
                        (worst, at) = (d, (x, y));
                    }
                    let ink: f64 = (0..3)
                        .map(|k| (f64::from(lv[k]) - f64::from(bg[k])).abs())
                        .sum();
                    if ink >= 120.0 {
                        let got: f64 = (0..3)
                            .map(|k| (f64::from(rv[k]) - f64::from(bg[k])).abs())
                            .sum();
                        sum += got / ink;
                        n += 1;
                    }
                }
            }
            if worst > 2 {
                failures.push(format!("{tier:?} {theme:?}: {worst}/255 off at {at:?}"));
            }
            let mean = if n > 0 { sum / f64::from(n) } else { f64::NAN };
            if !((0.34..=0.36).contains(&mean)) {
                failures.push(format!(
                    "{tier:?} {theme:?}: mean alpha {mean} over {n} pixels"
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn dim_layer_lifecycle() {
    let chunk = s3();
    let mut failures = Vec::new();
    for tier in [Tier::T1, Tier::T2] {
        let ctx1 = ctx(tier);
        let list = |w: f64, sel: SelectionIn| {
            build_frame(&viewport(&chunk, (w, 240.0), Theme::Dark, LINE, sel)).list
        };
        let mut r = Renderer::new(
            &ctx1,
            wgpu::TextureFormat::Rgba8Unorm,
            RendererOptions::default(),
        );
        let steps = [
            ("select", list(1118.0, keys(&[A2])), Some((1118, 240))),
            ("resize", list(600.0, keys(&[A2])), Some((600, 240))),
            ("clear", list(600.0, SelectionIn::default()), None),
            ("re-select", list(600.0, keys(&[A2])), Some((600, 240))),
        ];
        let mut last = None;
        for (what, l, size) in &steps {
            let (px, _) = render(&ctx1, &mut r, l);
            if r.dim_layer_size() != *size {
                failures.push(format!(
                    "{tier:?} {what}: layer {:?}, want {size:?}",
                    r.dim_layer_size()
                ));
            }
            if px != fresh(&ctx1, l).px {
                failures.push(format!("{tier:?} {what}: differs from a fresh renderer's"));
            }
            last = Some(px);
        }
        let plain = fresh(&ctx1, &list(600.0, SelectionIn::default()));
        let cleared = render(&ctx1, &mut r, &steps[2].1).0;
        if cleared != plain.px {
            failures.push(format!(
                "{tier:?}: the cleared image is not the unselected one"
            ));
        }
        // A new renderer on a new context (as after a device loss): the layer is made again.
        let ctx2 = ctx(tier);
        let mut r2 = Renderer::new(
            &ctx2,
            wgpu::TextureFormat::Rgba8Unorm,
            RendererOptions::default(),
        );
        let (px, _) = render(&ctx2, &mut r2, &steps[3].1);
        if r2.dim_layer_size() != Some((600, 240)) {
            failures.push(format!(
                "{tier:?} new context: layer {:?}",
                r2.dim_layer_size()
            ));
        }
        if Some(px) != last {
            failures.push(format!("{tier:?} new context: differs"));
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
