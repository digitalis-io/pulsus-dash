//! unit:hover-parity (plan #68 C2b §5 `hover_parity`, `overlay_item`; INT-033, T25-005): the Rust
//! port of the Canvas 2D hover and click rules (`canvas2d/pick.ts` `hoverAt`, `select.ts`
//! `pickItem`, `data/frames.ts` `seriesName`) gives what the TS gives on the same model
//! (`engine/fixtures/hover.json`, f64 equal by bits), and the overlay item of a hover and a box band
//! is the TS `drawOverlay`'s, in its order.
#[path = "../../../tests-common/fixture.rs"]
mod fixture;

use std::sync::Arc;

use dash_scene::hover::{
    HoverAt, HoverItem, HoverOut, PickSnap, Source, hover_at, overlay_item, pick_item, series_name,
};
use dash_scene::{
    Band, Camera, PlotCamera, PlotRect, Range64, Size64, Theme, ValueAxis, ValueRange, Viewport,
    VisSpec, build_frame,
};
use dash_tokens::{ColourRole, colour, series_palette};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};
use serde_json::Value;

fn labels_of(v: &Value) -> Vec<(String, String)> {
    v.as_object()
        .map(|o| {
            o.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
                .collect()
        })
        .unwrap_or_default()
}

fn chunk_of(series: &Value) -> Chunk {
    let mut b = ChunkBuilder::explicit(ChunkId(1 << 63));
    for s in series.as_array().into_iter().flatten() {
        let key = u64::from_str_radix(s["key"].as_str().unwrap_or_default(), 16).unwrap_or(0);
        let meta = SeriesMeta {
            key_hash: key,
            labels: labels_of(&s["labels"]).into(),
        };
        let pushed = b.push_series(meta, Some(&fixture::nums(&s["t"])), &fixture::nums(&s["v"]));
        assert!(pushed.is_ok(), "{pushed:?}");
    }
    b.finish()
}

fn plot_of(v: &Value) -> PlotRect {
    PlotRect {
        x: fixture::num(&v["x"]),
        y: fixture::num(&v["y"]),
        width: fixture::num(&v["width"]),
        height: fixture::num(&v["height"]),
    }
}

/// The snapshot of a fixture case: its chunk, shown series, view and the TS layout's axis.
fn snap_of(r: &Value) -> PickSnap {
    PickSnap {
        chunk: Arc::new(chunk_of(&r["series"])),
        shown: r["shown"].as_u64().unwrap_or(0) as u32,
        view: Range64 {
            lo: fixture::num(&r["view"]["lo"]),
            hi: fixture::num(&r["view"]["hi"]),
        },
        axis: ValueAxis {
            plot: plot_of(&r["plot"]),
            domain: Range64 {
                lo: fixture::num(&r["domain"]["min"]),
                hi: fixture::num(&r["domain"]["max"]),
            },
            ticks: Vec::new(),
            labels: Vec::new(),
            manual: false,
            band_w: 0.0,
        },
    }
}

fn same(a: f64, b: f64, what: &str) {
    assert!(fixture::same(a, b), "{what}: {a:?} vs {b:?}");
}

fn check_hover(got: Option<&HoverOut>, want: &Value, what: &str) {
    let Some(got) = got else {
        assert!(want.is_null(), "{what}: none, want {want}");
        return;
    };
    assert!(!want.is_null(), "{what}: {got:?}, want null");
    let source = match got.source {
        Source::Pointer => "pointer",
        Source::Keyboard => "keyboard",
    };
    assert_eq!(
        source,
        want["source"].as_str().unwrap_or_default(),
        "{what}"
    );
    same(got.t_ms, fixture::num(&want["tMs"]), what);
    same(got.x_css, fixture::num(&want["xCss"]), what);
    same(got.y_css, fixture::num(&want["yCss"]), what);
    let rows = want["rows"].as_array().cloned().unwrap_or_default();
    assert_eq!(got.rows.len(), rows.len(), "{what}: rows");
    for (g, w) in got.rows.iter().zip(&rows) {
        assert_eq!(g.key, w["key"].as_str().unwrap_or_default(), "{what}");
        assert_eq!(g.name, w["name"].as_str().unwrap_or_default(), "{what}");
        assert_eq!(
            u64::from(g.colour_index),
            w["colourIndex"].as_u64().unwrap_or(99),
            "{what}"
        );
        same(g.value, fixture::num(&w["value"]), what);
    }
}

fn check_item(got: Option<&HoverItem>, want: &Value, what: &str) {
    let Some(HoverItem::Point { key, t_ms, value }) = got else {
        assert!(want.is_null(), "{what}: none, want {want}");
        return;
    };
    assert_eq!(want["kind"].as_str(), Some("point"), "{what}");
    assert_eq!(key, want["key"].as_str().unwrap_or_default(), "{what}");
    same(*t_ms, fixture::num(&want["tMs"]), what);
    same(*value, fixture::num(&want["value"]), what);
}

#[test]
fn hover_parity() {
    let rows = fixture::load("hover.json");
    assert!(rows.len() >= 7, "hover.json has {} cases", rows.len());
    let (mut hovers, mut picks, mut names) = (0, 0, 0);
    for r in &rows {
        let case = r["case"].as_str().unwrap_or_default();
        if case == "names" {
            for n in r["names"].as_array().into_iter().flatten() {
                let got = series_name(&labels_of(&n["labels"]));
                assert_eq!(got, n["name"].as_str().unwrap_or_default(), "{n}");
                names += 1;
            }
            continue;
        }
        let s = snap_of(r);
        for (k, h) in r["hovers"].as_array().into_iter().flatten().enumerate() {
            let at = match (&h["key"], &h["p"]) {
                (Value::Number(i), _) => HoverAt::Key(i.as_u64().unwrap_or(0) as u32),
                (_, Value::Object(_)) => HoverAt::Pointer {
                    x: fixture::num(&h["p"]["x"]),
                    y: fixture::num(&h["p"]["y"]),
                },
                _ => HoverAt::None,
            };
            let got = hover_at(&s, at);
            check_hover(got.as_ref(), &h["out"], &format!("{case} hover {k} {at:?}"));
            hovers += 1;
        }
        for (k, p) in r["picks"].as_array().into_iter().flatten().enumerate() {
            let (x, y) = (fixture::num(&p["p"]["x"]), fixture::num(&p["p"]["y"]));
            let got = pick_item(&s, x, y);
            check_item(
                got.as_ref(),
                &p["out"],
                &format!("{case} pick {k} ({x}, {y})"),
            );
            picks += 1;
        }
    }
    // 200 seeded pointers over the cases, each hovered and clicked; three key indices per case.
    assert!(hovers >= 200 + 3 * 6, "{hovers} hovers");
    assert!(picks >= 200, "{picks} picks");
    assert!(names >= 6, "{names} names");
}

/// The line-50 frame at 1118×240 on a manual axis 0..5 (dark): its snapshot.
fn line50_manual() -> Arc<PickSnap> {
    let (chunk, mut spec) = gallery_line(GalleryLine::Line50, GALLERY_WINDOW);
    spec.value_range = Some(ValueRange { min: 0.0, max: 5.0 });
    let spec = VisSpec::Line(spec);
    let v = Viewport {
        id: 1,
        frame_id: None,
        css: Size64 {
            w: 1118.0,
            h: 240.0,
        },
        dpr: 1.0,
        theme: Theme::Dark,
        camera: Camera::Plot2D(PlotCamera::idle(Range64::from(GALLERY_WINDOW), &spec)),
        spec,
        data: Some(Arc::new(chunk)),
        band: Band::Measure,
        events: std::sync::Arc::from([]),
        selection: Default::default(),
    };
    let b = build_frame(&v);
    assert!(b.stage.is_some(), "a stage");
    let Some(pick) = b.pick else {
        panic!("build_frame: no pick with a stage")
    };
    pick
}

#[test]
fn overlay_item_shapes() {
    use dash_marks::{MarkItem, OverlayShape};
    let s = line50_manual();
    let plot = s.axis.plot;
    let xs = plot.x + 0.3 * plot.width;
    let Some(h) = hover_at(
        &s,
        HoverAt::Pointer {
            x: xs,
            y: plot.y + plot.height / 2.0,
        },
    ) else {
        panic!("no hover at xs(0.3)")
    };
    assert!(h.x_css.fract() != 0.0, "precondition: an unrounded x");
    let outside: Vec<usize> = (0..h.rows.len())
        .filter(|&k| {
            let y = s.axis.y(h.rows[k].value);
            !(y >= plot.y && y <= plot.y + plot.height)
        })
        .collect();
    assert!(
        outside.contains(&9),
        "precondition: row 9 outside, {outside:?}"
    );
    let MarkItem::Overlay { shapes } = overlay_item(&s, Some(&h), Some((100.0, 40.0)), Theme::Dark)
    else {
        panic!("not an overlay item")
    };
    let pal = series_palette(Theme::Dark);
    let mut want = vec![OverlayShape::Rect {
        css: [
            dash_units::js_round(h.x_css) as f32,
            plot.y as f32,
            1.0,
            plot.height as f32,
        ],
        colour: colour(Theme::Dark, ColourRole::TextMuted),
    }];
    for (k, r) in h.rows.iter().enumerate() {
        if outside.contains(&k) {
            continue;
        }
        want.push(OverlayShape::Disc {
            centre: [h.x_css as f32, s.axis.y(r.value) as f32],
            r_css: 3.0,
            colour: pal[usize::from(r.colour_index)],
        });
    }
    want.push(OverlayShape::Rect {
        css: [40.0, plot.y as f32, 60.0, plot.height as f32],
        colour: colour(Theme::Dark, ColourRole::Brush),
    });
    assert_eq!(shapes, want);
    // No hover and no box: nothing.
    let MarkItem::Overlay { shapes } = overlay_item(&s, None, None, Theme::Light) else {
        panic!("not an overlay item")
    };
    assert!(shapes.is_empty());
}
