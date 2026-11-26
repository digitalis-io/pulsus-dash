//! unit:layer-parity (plan #68 C2c1 §5 `layer_parity`, `build_layer_items`; T02-009, ADR-0022,
//! ADR-0023): the engine's threshold and event lines are the Canvas 2D strokes of the same layer
//! (`engine/fixtures/layer.json`, recorded from `drawLayer`'s own stroke calls): the plot and the
//! value domain equal by f64 bits; each threshold is one rect per dash run of its recorded stroke
//! (`y0` = the stroke's y − 0.5, from its `moveTo` x to its `lineTo` x, pattern 5/4 at offset 0) in
//! its state colour; each event is one `text-muted` rect at the stroke's x − 0.5. At the plot's
//! right edge: under a pinned axis (the stroke clipped) it is cut there and dropped; on an auto
//! axis, where Canvas 2D strokes it one column right of the plot, the engine draws it in the plot's
//! last column (ADR-0023: a line for every event in view).
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::sync::Arc;

use dash_marks::{MarkItem, OverlayShape};
use dash_scene::{
    Band, Camera, PlotCamera, Range64, Size64, Theme, ThresholdLine, ThresholdState, Viewport,
    VisSpec, build_frame,
};
use dash_tokens::{ColourRole, Rgba8, colour};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};
use serde_json::Value;

fn chunk_of(series: &Value) -> Chunk {
    let mut b = ChunkBuilder::explicit(ChunkId(1 << 63));
    for s in series.as_array().into_iter().flatten() {
        let key = u64::from_str_radix(s["key"].as_str().unwrap_or_default(), 16).unwrap_or(0);
        let labels: Vec<(String, String)> = s["labels"]
            .as_object()
            .map(|o| {
                o.iter()
                    .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        let meta = SeriesMeta {
            key_hash: key,
            labels: labels.into(),
        };
        let pushed = b.push_series(meta, Some(&fixture::nums(&s["t"])), &fixture::nums(&s["v"]));
        assert!(pushed.is_ok(), "{pushed:?}");
    }
    b.finish()
}

fn hex(c: Rgba8) -> String {
    format!("#{:02X}{:02X}{:02X}", c.0[0], c.0[1], c.0[2])
}

fn role_of(state: &str) -> ColourRole {
    match state {
        "watch" => ColourRole::Watch,
        "degraded" => ColourRole::Degraded,
        "failing" => ColourRole::Failing,
        other => panic!("state {other:?}"),
    }
}

/// A case's viewport at a frame's size: its spec, series, events and window, on the idle camera.
fn viewport_of(r: &Value, f: &Value) -> Viewport {
    let spec = match VisSpec::from_json(r["spec"].as_str().unwrap_or_default()) {
        Ok(s) => s,
        Err(e) => panic!("{}: {e}", r["case"]),
    };
    let window = Range64 {
        lo: fixture::num(&r["window"]["fromMs"]),
        hi: fixture::num(&r["window"]["toMs"]),
    };
    Viewport {
        id: 1,
        frame_id: None,
        css: Size64 {
            w: fixture::num(&f["w"]),
            h: fixture::num(&f["h"]),
        },
        dpr: fixture::num(&f["dpr"]) as f32,
        theme: Theme::Dark,
        camera: Camera::Plot2D(PlotCamera::idle(window, &spec)),
        spec,
        data: Some(Arc::new(chunk_of(&r["series"]))),
        band: Band::Measure,
        events: Arc::from(fixture::nums(&r["events"])),
        selection: Default::default(),
    }
}

/// The layer `Overlay` item's shapes: none when the list has no Overlay item.
fn layer_shapes(items: &[MarkItem]) -> Vec<OverlayShape> {
    let overlays: Vec<&Vec<OverlayShape>> = items
        .iter()
        .filter_map(|i| match i {
            MarkItem::Overlay { shapes } => Some(shapes),
            _ => None,
        })
        .collect();
    assert!(overlays.len() <= 1, "one layer Overlay item at most");
    overlays.first().map(|s| (*s).clone()).unwrap_or_default()
}

fn same(a: f64, b: f64, what: &str) {
    assert!(fixture::same(a, b), "{what}: {a:?} vs {b:?}");
}

#[test]
fn layer_parity() {
    let rows = fixture::load("layer.json");
    assert!(rows.len() >= 13, "layer.json has {} cases", rows.len());
    let (mut dashes, mut events, mut dropped, mut clamped) = (0, 0, 0, 0);
    for r in &rows {
        let case = r["case"].as_str().unwrap_or_default();
        for f in r["frames"].as_array().into_iter().flatten() {
            let what = format!("{case} {}×{}@{}", f["w"], f["h"], f["dpr"]);
            let b = build_frame(&viewport_of(r, f));
            let Some(stage) = b.stage else {
                panic!("{what}: no stage")
            };
            let p = stage.plot;
            same(
                p.x,
                fixture::num(&f["plot"]["x"]),
                &format!("{what}: plot.x"),
            );
            same(
                p.y,
                fixture::num(&f["plot"]["y"]),
                &format!("{what}: plot.y"),
            );
            same(
                p.width,
                fixture::num(&f["plot"]["width"]),
                &format!("{what}: plot.width"),
            );
            same(
                p.height,
                fixture::num(&f["plot"]["height"]),
                &format!("{what}: plot.height"),
            );
            let Some(d) = stage.domain else {
                panic!("{what}: no domain")
            };
            same(
                d.lo,
                fixture::num(&f["domain"]["min"]),
                &format!("{what}: min"),
            );
            same(
                d.hi,
                fixture::num(&f["domain"]["max"]),
                &format!("{what}: max"),
            );
            let mut want = Vec::new();
            for t in f["thresholds"].as_array().into_iter().flatten() {
                // The recorded stroke: a 5/4 dash from offset 0, at a pixel centre.
                assert_eq!(fixture::nums(&t["dash"]), [5.0, 4.0], "{what}: pattern");
                assert_eq!(fixture::num(&t["offset"]), 0.0, "{what}: offset");
                let y0 = fixture::num(&t["y"]) - 0.5;
                let (x0, x1) = (fixture::num(&t["x0"]), fixture::num(&t["x1"]));
                let c = colour(
                    Theme::Dark,
                    role_of(t["state"].as_str().unwrap_or_default()),
                );
                assert_eq!(hex(c), t["colour"].as_str().unwrap_or_default(), "{what}");
                let runs: Vec<Vec<f64>> = t["runs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(fixture::nums)
                    .collect();
                assert_eq!(
                    runs.first().map(|r| r[0]),
                    Some(x0),
                    "{what}: from moveTo x"
                );
                // The last dash starts before the `lineTo` x and ends by it.
                let end = runs.last().map_or((f64::NAN, f64::NAN), |r| (r[0], r[1]));
                assert!(
                    end.0 < x1 && end.0 + 9.0 >= x1 && end.1 == (end.0 + 5.0).min(x1),
                    "{what}: to lineTo x {x1}: {end:?}"
                );
                for run in runs {
                    want.push(OverlayShape::Rect {
                        css: [run[0] as f32, y0 as f32, (run[1] - run[0]) as f32, 1.0],
                        colour: c,
                    });
                    dashes += 1;
                }
            }
            let right = p.x + p.width;
            for e in f["events"].as_array().into_iter().flatten() {
                let c = colour(Theme::Dark, ColourRole::TextMuted);
                assert_eq!(hex(c), e["colour"].as_str().unwrap_or_default(), "{what}");
                let mut x = fixture::num(&e["x"]) - 0.5;
                if x + 1.0 > right {
                    if e["clip"].as_bool() == Some(true) {
                        dropped += 1;
                        continue;
                    }
                    clamped += 1;
                    x = right - 1.0;
                }
                want.push(OverlayShape::Rect {
                    css: [
                        x as f32,
                        p.y as f32,
                        (right - x).min(1.0) as f32,
                        p.height as f32,
                    ],
                    colour: c,
                });
                events += 1;
            }
            assert_eq!(layer_shapes(&b.list.items), want, "{what}");
        }
    }
    assert!(dashes > 1000, "{dashes} dashes");
    assert!(events >= 20, "{events} event lines");
    assert!(
        dropped >= 4,
        "{dropped} pinned window-end events cut at the right edge"
    );
    // events-ends-auto at 5 sizes: the end, and the event rounding to it, in the last column.
    assert!(
        clamped >= 10,
        "{clamped} auto-axis events drawn in the plot's last column"
    );
}

/// Plan #68 C2c1 §5 `build_layer_items` (§4.2): with thresholds and an event the list is Guides,
/// Line, then the layer Overlay; the summary's min and max stay the data's while the domain widens;
/// with neither there is no layer Overlay.
#[test]
fn build_layer_items() {
    let (chunk, spec) = gallery_line(GalleryLine::Line50, GALLERY_WINDOW);
    let chunk = Arc::new(chunk);
    let viewport = |spec: dash_scene::LineSpec, events: Vec<f64>| {
        let spec = VisSpec::Line(spec);
        Viewport {
            id: 1,
            frame_id: None,
            css: Size64 {
                w: 1118.0,
                h: 240.0,
            },
            dpr: 1.0,
            theme: Theme::Light,
            camera: Camera::Plot2D(PlotCamera::idle(Range64::from(GALLERY_WINDOW), &spec)),
            spec,
            data: Some(chunk.clone()),
            band: Band::Measure,
            events: Arc::from(events),
            selection: Default::default(),
        }
    };
    let plain = build_frame(&viewport(spec.clone(), Vec::new()));
    let kinds = |items: &[MarkItem]| -> Vec<&'static str> {
        items
            .iter()
            .map(|i| match i {
                MarkItem::Guides { .. } => "Guides",
                MarkItem::Line { .. } => "Line",
                MarkItem::Overlay { .. } => "Overlay",
            })
            .collect()
    };
    assert_eq!(kinds(&plain.list.items), ["Guides", "Line"]);
    let Some(s0) = plain.summary else {
        panic!("no summary")
    };
    let mut with = spec;
    with.thresholds = vec![
        ThresholdLine {
            value: Some(1e4),
            state: ThresholdState::Failing,
        },
        ThresholdLine {
            value: Some(100.0),
            state: ThresholdState::Watch,
        },
    ];
    let b = build_frame(&viewport(with, vec![GALLERY_WINDOW.0 + 1_800_000.0]));
    assert_eq!(kinds(&b.list.items), ["Guides", "Line", "Overlay"]);
    let shapes = layer_shapes(&b.list.items);
    let muted = colour(Theme::Light, ColourRole::TextMuted);
    let last = shapes.last().cloned();
    assert!(
        matches!(last, Some(OverlayShape::Rect { colour: c, .. }) if c == muted),
        "the event line last: {last:?}"
    );
    let Some(s) = b.summary else {
        panic!("no summary")
    };
    assert_eq!((s.min, s.max, s.last), (s0.min, s0.max, s0.last));
    let axis = s.value_axis.map(|a| a.max);
    assert!(
        axis.is_some_and(|m| m >= 1e4),
        "the domain widens: {axis:?}"
    );
    // The event band: the plot starts 18 px (TS EVENT_BAND) lower and is as much shorter.
    assert_eq!(s.plot.y, s0.plot.y + 18.0);
    assert_eq!(s.plot.height, s0.plot.height - 18.0);
}
