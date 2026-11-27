//! The line area (#282 Part 2b §5; ADR-0036):
//!
//! - `area_spec`: `area` parses, absent = false.
//! - `area_item`: `build_frame` gives the Line item `alpha_top` = `opacity.chart-area` ÷ shown for
//!   1–4 series, None for 5, with `area` off and under any selection (matched or not); the guides
//!   carry the baseline, palette slots 8 and 9 are `chart-grid` and `chart-axis`.
//! - `area_pieces_fixture`: `area_pieces` on the GPU's ends (f32, clipped as decimation clips a far
//!   item) gives each `area-pieces.json` case's pieces within ±1 px.
mod common;
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::sync::Arc;

use common::*;
use dash_marks::{Area, MarkItem};
use dash_scales::Range64;
use dash_scales::decimate::{CLIP_HIGH, CLIP_LOW, INST_CLIP_A_SHIFT, INST_CLIP_B_SHIFT};
use dash_scales::encode::{SegClip, Side, axis_map, choose_encoding, clip_segment, is_far};
use dash_scene::{
    AreaPiece, Band, LineSpec, PieceClass, SelectionIn, VisSpec, area_pieces, build_frame,
    join_ends,
};
use dash_tokens::{ColourRole, Theme, colour};
use dash_units::Unit;
use dash_wire::{ChunkBuilder, ChunkId, SeriesMeta};

fn line_spec(json: &str) -> LineSpec {
    match VisSpec::from_json(json) {
        Ok(VisSpec::Line(l)) => l,
        other => panic!("{other:?}"),
    }
}

#[test]
fn area_spec() {
    let on = line_spec(r#"{"kind":"line","title":"T","unit":{"kind":"none"},"area":true}"#);
    assert!(on.area);
    let off = line_spec(r#"{"kind":"line","title":"T","unit":{"kind":"none"}}"#);
    assert!(!off.area);
    assert!(!LineSpec::new(Unit::None).area);
}

/// `n` series of 60 samples one second apart from T0, keys 1..=n.
fn chunk(n: u64) -> dash_wire::Chunk {
    let mut b = ChunkBuilder::explicit(ChunkId(0xa7ea));
    let ts: Vec<f64> = (0..60).map(|k| T0 + 1000.0 * f64::from(k)).collect();
    for s in 1..=n {
        let vs: Vec<f64> = (0..60).map(|k| f64::from(k) + s as f64).collect();
        let meta = SeriesMeta {
            key_hash: s,
            labels: Vec::new().into(),
        };
        if let Err(e) = b.push_series(meta, Some(&ts), &vs) {
            panic!("{e}");
        }
    }
    b.finish()
}

fn item_area(n: u64, area: bool, sel: SelectionIn) -> (Option<Area>, dash_scene::Built) {
    let mut spec = LineSpec::new(Unit::None);
    spec.area = area;
    let window = Range64 {
        lo: T0,
        hi: T0 + 59_000.0,
    };
    let mut v = viewport(chunk(n), spec, window, Band::Measure);
    v.selection = Arc::new(sel);
    let b = build_frame(&v);
    let a = b.list.items.iter().find_map(|i| match i {
        MarkItem::Line { area, .. } => Some(*area),
        _ => None,
    });
    let Some(a) = a else {
        panic!("{n} series: no Line item")
    };
    (a, b)
}

#[test]
fn area_item() {
    let none = SelectionIn::default;
    let alpha = |n| item_area(n, true, none()).0.map(|a| a.alpha_top);
    let close = |a: Option<f32>, e: f32| a.is_some_and(|a| (a - e).abs() < 1e-6);
    assert!(close(alpha(1), 0.18), "{:?}", alpha(1));
    assert!(close(alpha(3), 0.06), "{:?}", alpha(3));
    assert!(close(alpha(4), 0.045), "{:?}", alpha(4));
    assert_eq!(alpha(5), None);
    assert_eq!(item_area(3, false, none()).0, None, "area off");
    let matched = SelectionIn::new(["0000000000000002"], None, None);
    assert_eq!(item_area(3, true, matched).0, None, "a matched selection");
    let unmatched = SelectionIn::new(["00000000000000ff"], None, None);
    assert_eq!(item_area(3, true, unmatched).0, None, "an unmatched selection");
    let interval = SelectionIn::new(std::iter::empty(), Some(T0), Some(T0 + 9_000.0));
    assert_eq!(item_area(3, true, interval).0, None, "an interval selection");
    let (_, b) = item_area(1, true, none());
    let Some(s) = b.summary else {
        panic!("no summary")
    };
    let want = ((s.plot.y + s.plot.height).round() - 1.0) as f32;
    let baseline = b.list.items.iter().find_map(|i| match i {
        MarkItem::Guides { baseline, .. } => Some(*baseline),
        _ => None,
    });
    assert_eq!(baseline, Some(want));
    assert_eq!(b.list.palette[8], colour(Theme::Dark, ColourRole::ChartGrid));
    assert_eq!(b.list.palette[9], colour(Theme::Dark, ColourRole::ChartAxis));
}

/// The plot of the fixture: x 0–100, rows 100 (top) to 300 (bottom).
const PLOT: [f32; 4] = [0.0, 100.0, 100.0, 200.0];

/// The GPU's join of a fixture case: the instance decimation would emit for the values `va`, `vb`
/// at columns `x0`, `x1` (clipped in f64 when the item is far), rebuilt by `join_ends`.
fn gpu_join(row: &serde_json::Value) -> Option<(f32, f32, [f32; 2], [f32; 2])> {
    let n = |k: &str| fixture::num(&row[k]);
    let (va, vb) = (n("va"), n("vb"));
    let axis = Range64 {
        lo: n("min"),
        hi: n("max"),
    };
    let data = Range64 {
        lo: va.min(vb),
        hi: va.max(vb),
    };
    let enc = choose_encoding(Some(data), axis, 200.0)?;
    let m = axis_map(&enc, axis, 200.0);
    let (c, dx) = (n("x1") as u32, (n("x1") - n("x0")) as u32);
    let mut inst = (enc.encode(va), enc.encode(vb), 0u32);
    let (mut a, mut b) = (f32::from_bits(inst.0), f32::from_bits(inst.1));
    if is_far(&enc, Some((data.lo, data.hi))) {
        let code = |s: Side| if s == Side::Low { CLIP_LOW } else { CLIP_HIGH };
        match clip_segment(va, vb, &enc.clip_box()) {
            SegClip::Inside => {}
            SegClip::Clipped { a: ca, b: cb } => {
                if let Some((t, s)) = ca {
                    a = t as f32;
                    inst.2 |= code(s) << INST_CLIP_A_SHIFT;
                }
                if let Some((t, s)) = cb {
                    b = t as f32;
                    inst.2 |= code(s) << INST_CLIP_B_SHIFT;
                }
            }
            SegClip::Outside(s) => {
                (a, b) = (0.0, 1.0);
                inst.2 |= (code(s) << INST_CLIP_A_SHIFT) | (code(s) << INST_CLIP_B_SHIFT);
            }
        }
    }
    // The plot's x is 0 and joins run between column centres: shift by −0.5 to the fixture's x.
    let col = c | (dx << 16);
    join_ends(col, a, b, inst.2, [-0.5, PLOT[1], PLOT[2], PLOT[3]], (m.ku as f32, m.ou as f32))
}

fn class_of(s: &str) -> PieceClass {
    match s {
        "A" => PieceClass::Above,
        "I" => PieceClass::Inside,
        _ => PieceClass::Below,
    }
}

/// `got` covers `want` within ±1 px: every boundary and every Inside edge y within 1, and the
/// pieces of each class wider than 1 px matched in order.
fn agrees(got: &[AreaPiece], want: &[serde_json::Value]) -> Result<(), String> {
    let wide = |p: &AreaPiece| p.x1 - p.x0 > 1.0;
    let got: Vec<&AreaPiece> = got.iter().filter(|p| wide(p)).collect();
    let want: Vec<&serde_json::Value> = want
        .iter()
        .filter(|p| fixture::num(&p["x1"]) - fixture::num(&p["x0"]) > 1.0)
        .collect();
    if got.len() != want.len() {
        return Err(format!("{} pieces, want {}: {got:?}", got.len(), want.len()));
    }
    for (g, w) in got.iter().zip(want) {
        let n = |k: &str| fixture::num(&w[k]) as f32;
        if g.class != class_of(w["cls"].as_str().unwrap_or_default()) {
            return Err(format!("{g:?} vs {w}"));
        }
        for (a, b) in [(g.x0, n("x0")), (g.x1, n("x1")), (g.y0, n("y0")), (g.y1, n("y1"))] {
            if !((a - b).abs() <= 1.0) {
                return Err(format!("{g:?} vs {w}"));
            }
        }
    }
    Ok(())
}

#[test]
fn area_pieces_fixture() {
    let rows = fixture::load("area-pieces.json");
    assert_eq!(rows.len(), 12, "area-pieces.json");
    for row in &rows {
        let id = row["case"].as_str().unwrap_or_default();
        let want = row["pieces"].as_array().cloned().unwrap_or_default();
        let got = match gpu_join(row) {
            Some((x0, x1, a, b)) => area_pieces(x0, x1, a, b, 100.0, 300.0),
            None => Vec::new(),
        };
        if want.is_empty() {
            assert!(got.is_empty(), "{id}: {got:?}");
            continue;
        }
        assert!(!got.is_empty(), "{id}: no pieces");
        if let Err(e) = agrees(&got, &want) {
            panic!("{id}: {e}");
        }
        for p in &got {
            assert!(
                [p.x0, p.x1, p.y0, p.y1].iter().all(|v| v.is_finite()),
                "{id}: {p:?}"
            );
            assert!(p.x0 <= p.x1, "{id}: {p:?}");
        }
    }
}
