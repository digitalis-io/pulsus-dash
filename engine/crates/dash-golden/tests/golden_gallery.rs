//! golden:gallery, engine line pages (plan #68 §5, T05-004, T05-005, T02-029, T02-030, VIZ-002):
//! the ten pages against the committed PNGs (mean ꟻLIP ≤ 0.005), T1 = T2 and repeat renders
//! byte-equal, on the pinned lavapipe. `GOLDEN_UPDATE=1` writes the baselines instead.
//! `golden:engine-overlay` (plan #68 C2b §5; T02-029): `line-50` dark and light with a hover at the
//! plot's centre column and a box band, T1 and T2 within mean ꟻLIP 0.001. Plan #68 C2c1 §5: the
//! layer pages `line-thresholds` and `line-events` (inputs from `layer.json`), dark and light,
//! against their committed PNGs, T1 and T2 within mean ꟻLIP 0.001.
mod common;

use common::*;
use dash_golden::{
    Image, LAYER_PAGES, OverlayAt, PAGE_CSS, flip_mean, goldens_dir, manual_range, page_viewport,
    pages, pinned_driver, render_layer_page, render_page, render_page_overlay,
};
use dash_gpu::Tier;
use dash_scene::Theme;
use pulsus_synth::GalleryLine;

#[test]
fn golden_gallery() {
    let update = std::env::var("GOLDEN_UPDATE").is_ok_and(|v| v == "1");
    let (t1, t2) = (ctx(Tier::T1), ctx(Tier::T2));
    let pinned = pinned_driver(&t1);
    assert!(pinned.is_ok(), "{pinned:?}");
    let mut failures = Vec::new();
    for page in pages() {
        let name = page.name();
        let vr = if page.manual {
            manual_range(page.line, PAGE_CSS)
        } else {
            None
        };
        assert!(!page.manual || vr.is_some(), "{name}: no manual range");
        let a = render_page(&t1, page.line, page.theme, PAGE_CSS, page.dpr, vr);
        let again = render_page(&t1, page.line, page.theme, PAGE_CSS, page.dpr, vr);
        let b = render_page(&t2, page.line, page.theme, PAGE_CSS, page.dpr, vr);
        assert!(a == again, "{name}: two renders differ");
        assert!(a == b, "{name}: T1 and T2 differ");
        let path = goldens_dir().join(format!("{name}.png"));
        if update {
            let w = a.write_png(&path);
            assert!(w.is_ok(), "{name}: {w:?}");
            continue;
        }
        match Image::read_png(&path) {
            Ok(golden) => {
                let mean = flip_mean(&golden, &a, &[]);
                if mean.is_nan() || mean > 0.005 {
                    failures.push(format!("{name}: mean FLIP {mean}"));
                }
            }
            Err(e) => failures.push(format!(
                "{name}: no baseline ({e}); run with the golden-update label"
            )),
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}

#[test]
fn golden_engine_overlay() {
    let update = std::env::var("GOLDEN_UPDATE").is_ok_and(|v| v == "1");
    let (t1, t2) = (ctx(Tier::T1), ctx(Tier::T2));
    let mut failures = Vec::new();
    for (theme, name) in [(Theme::Dark, "dark"), (Theme::Light, "light")] {
        let v = page_viewport(GalleryLine::Line50, theme, PAGE_CSS, 1.0, None);
        let Some(summary) = dash_scene::build(&v).1 else {
            panic!("line-50: no summary")
        };
        let p = summary.plot;
        let xs = |f: f64| p.x + f * p.width;
        let o = OverlayAt {
            hover: Some((xs(0.5), p.y + p.height / 2.0)),
            box_x: Some((xs(0.2), xs(0.4))),
        };
        let a = render_page_overlay(&t1, GalleryLine::Line50, theme, PAGE_CSS, 1.0, None, o);
        let b = render_page_overlay(&t2, GalleryLine::Line50, theme, PAGE_CSS, 1.0, None, o);
        let plain = render_page(&t1, GalleryLine::Line50, theme, PAGE_CSS, 1.0, None);
        let tiers = flip_mean(&a, &b, &[]);
        if tiers.is_nan() || tiers > 0.001 {
            failures.push(format!("{name}: T1 vs T2 mean FLIP {tiers}"));
        }
        if a == plain {
            failures.push(format!("{name}: no overlay drawn"));
        }
        let path = goldens_dir().join(format!("line-50-{name}-overlay.png"));
        if update {
            let w = a.write_png(&path);
            assert!(w.is_ok(), "{name}: {w:?}");
            continue;
        }
        match Image::read_png(&path) {
            Ok(golden) => {
                let mean = flip_mean(&golden, &a, &[]);
                if mean.is_nan() || mean > 0.005 {
                    failures.push(format!("{name} overlay: mean FLIP {mean}"));
                }
            }
            Err(e) => failures.push(format!("{name} overlay: no baseline ({e})")),
        }
    }
    for id in LAYER_PAGES {
        for (theme, name) in [(Theme::Dark, "dark"), (Theme::Light, "light")] {
            let render = |t| render_layer_page(t, id, theme, PAGE_CSS, 1.0);
            let (a, b) = match (render(&t1), render(&t2)) {
                (Ok(a), Ok(b)) => (a, b),
                (a, b) => panic!("{id} {name}: {:?} {:?}", a.err(), b.err()),
            };
            let tiers = flip_mean(&a, &b, &[]);
            if tiers.is_nan() || tiers > 0.001 {
                failures.push(format!("{id}-{name}: T1 vs T2 mean FLIP {tiers}"));
            }
            let path = goldens_dir().join(format!("{id}-{name}.png"));
            if update {
                let w = a.write_png(&path);
                assert!(w.is_ok(), "{id}-{name}: {w:?}");
                continue;
            }
            match Image::read_png(&path) {
                Ok(golden) => {
                    let mean = flip_mean(&golden, &a, &[]);
                    if mean.is_nan() || mean > 0.005 {
                        failures.push(format!("{id}-{name}: mean FLIP {mean}"));
                    }
                }
                Err(e) => failures.push(format!("{id}-{name}: no baseline ({e})")),
            }
        }
    }
    assert!(failures.is_empty(), "{failures:#?}");
}
