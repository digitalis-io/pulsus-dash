//! unit:selection-parity (plan #68 C2c2 §5 `selection_parity`, `build_selection_items`; T25-006,
//! ADR-0025): the engine's selection matching and interval band are Canvas 2D's
//! (`engine/fixtures/selection.json`: TS `matchedKeys` over the shown keys, and the
//! `drawSelectionBand` rect of `drawLayer`'s own call with the plot it was drawn on). A key is a
//! match only as the same 16 lower-case hex digits; the band rect equals the recorded one as f32.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::sync::Arc;

use dash_marks::{MarkItem, OverlayShape};
use dash_scene::{
    Band, Camera, PlotCamera, PlotRect, Range64, SelectionIn, Size64, Theme, ThresholdLine,
    ThresholdState, Viewport, VisSpec, build_frame, matched, selection_band,
};
use dash_tokens::{ColourRole, colour, opacity};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};
use serde_json::Value;

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .map(|k| k.as_str().unwrap_or_default().to_owned())
                .collect()
        })
        .unwrap_or_default()
}

/// One sample per series, keyed as the case's series.
fn chunk_of(keys: &[String]) -> Chunk {
    let mut b = ChunkBuilder::explicit(ChunkId(7));
    for k in keys {
        let meta = SeriesMeta {
            key_hash: u64::from_str_radix(k, 16).unwrap_or(0),
            labels: Vec::new().into(),
        };
        assert!(b.push_series(meta, Some(&[0.0]), &[1.0]).is_ok());
    }
    b.finish()
}

fn selection_of(v: &Value) -> SelectionIn {
    let keys = strs(&v["keys"]);
    let opt = |x: &Value| (!x.is_null()).then(|| fixture::num(x));
    SelectionIn::new(
        keys.iter().map(String::as_str),
        opt(&v["fromMs"]),
        opt(&v["toMs"]),
    )
}

#[test]
fn selection_parity() {
    let rows = fixture::load("selection.json");
    assert!(rows.len() >= 20, "selection.json has {} cases", rows.len());
    let (mut matches, mut bands, mut drawn) = (0, 0, 0);
    for r in &rows {
        let case = r["case"].as_str().unwrap_or_default();
        match r["kind"].as_str() {
            Some("match") => {
                matches += 1;
                let all = strs(&r["series"]);
                let chunk = chunk_of(&all);
                let shown = all.len().min(500);
                let sel = SelectionIn::new(strs(&r["keys"]).iter().map(String::as_str), None, None);
                let got = matched(&chunk, shown, &sel);
                let want = (!r["matched"].is_null()).then(|| {
                    let hit = strs(&r["matched"]);
                    all[..shown]
                        .iter()
                        .map(|k| hit.contains(k))
                        .collect::<Vec<bool>>()
                });
                assert_eq!(got, want, "{case}: matched");
            }
            Some("band") => {
                bands += 1;
                let p = &r["plot"];
                let plot = PlotRect {
                    x: fixture::num(&p["x"]),
                    y: fixture::num(&p["y"]),
                    width: fixture::num(&p["width"]),
                    height: fixture::num(&p["height"]),
                };
                let view = Range64 {
                    lo: fixture::num(&r["window"]["fromMs"]),
                    hi: fixture::num(&r["window"]["toMs"]),
                };
                let dpr = fixture::num(&r["dpr"]) as f32;
                let got = selection_band(
                    &plot,
                    view,
                    &selection_of(&r["selection"]),
                    dpr,
                    Theme::Dark,
                );
                let want = (!r["rect"].is_null()).then(|| {
                    let v = fixture::nums(&r["rect"]);
                    OverlayShape::Rect {
                        css: [v[0] as f32, v[1] as f32, v[2] as f32, v[3] as f32],
                        colour: colour(Theme::Dark, ColourRole::Selection),
                    }
                });
                drawn += usize::from(want.is_some());
                assert_eq!(got, want, "{case}: band");
            }
            Some("order") => {}
            other => panic!("{case}: kind {other:?}"),
        }
    }
    assert!(
        matches >= 8 && bands >= 13 && drawn >= 9,
        "{matches} {bands} {drawn}"
    );
}

fn layer_shapes(items: &[MarkItem]) -> Vec<OverlayShape> {
    items
        .iter()
        .filter_map(|i| match i {
            MarkItem::Overlay { shapes } => Some(shapes.clone()),
            _ => None,
        })
        .flatten()
        .collect()
}

#[test]
fn build_selection_items() {
    let (chunk, mut spec) = gallery_line(GalleryLine::Line50, GALLERY_WINDOW);
    spec.thresholds = vec![
        ThresholdLine {
            value: Some(1e4),
            state: ThresholdState::Failing,
        },
        ThresholdLine {
            value: Some(100.0),
            state: ThresholdState::Watch,
        },
    ];
    let key3 = format!("{:016x}", chunk.series[3].key_hash);
    let chunk = Arc::new(chunk);
    let spec = VisSpec::Line(spec);
    let t0 = GALLERY_WINDOW.0;
    let viewport = |sel: SelectionIn| Viewport {
        id: 1,
        frame_id: None,
        css: Size64 {
            w: 1118.0,
            h: 240.0,
        },
        dpr: 1.0,
        theme: Theme::Dark,
        camera: Camera::Plot2D(PlotCamera::idle(Range64::from(GALLERY_WINDOW), &spec)),
        spec: spec.clone(),
        data: Some(chunk.clone()),
        band: Band::Measure,
        events: Arc::from([t0 + 1_800_000.0]),
        selection: Arc::new(sel),
        fit: None,
        fade: None,
    };
    let interval = (Some(t0 + 600_000.0), Some(t0 + 1_200_000.0));
    let plain = build_frame(&viewport(SelectionIn::default()));
    let b = build_frame(&viewport(SelectionIn::new(
        [key3.as_str()],
        interval.0,
        interval.1,
    )));
    let line_of = |items: &[MarkItem]| {
        items
            .iter()
            .find_map(|i| match i {
                MarkItem::Line { emphasis, .. } => Some(emphasis.clone()),
                _ => None,
            })
            .unwrap_or_else(|| panic!("no Line item"))
    };
    let Some(e) = line_of(&b.list.items) else {
        panic!("series 3 selected: no emphasis")
    };
    let want: Vec<bool> = (0..50).map(|i| i == 3).collect();
    assert_eq!(e.matched, want);
    assert_eq!(e.dimmed, opacity::DIMMED);
    assert_eq!(e.focus, colour(Theme::Dark, ColourRole::Focus));
    assert_eq!(e.underlay_extra_css, 4.0);
    // The layer Overlay: the band first, then the thresholds and the event (C2c1's shapes).
    let base = layer_shapes(&plain.list.items);
    let shapes = layer_shapes(&b.list.items);
    let sel = colour(Theme::Dark, ColourRole::Selection);
    assert!(
        matches!(shapes.first(), Some(OverlayShape::Rect { colour, .. }) if *colour == sel),
        "the band first: {:?}",
        shapes.first()
    );
    assert_eq!(&shapes[1..], &base[..], "then C2c1's thresholds and events");
    // Foreign keys: no emphasis, the band kept.
    let foreign = build_frame(&viewport(SelectionIn::new(
        ["00000000000000ff", "00000000000000A3"],
        interval.0,
        interval.1,
    )));
    assert_eq!(line_of(&foreign.list.items), None);
    assert_eq!(layer_shapes(&foreign.list.items), shapes);
    // No selection: C2c1's list (no emphasis, the same shapes).
    assert_eq!(line_of(&plain.list.items), None);
    assert!(
        !base
            .iter()
            .any(|s| matches!(s, OverlayShape::Rect { colour, .. } if *colour == sel)),
        "no band without a selection"
    );
}
