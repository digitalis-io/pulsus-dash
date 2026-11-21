//! golden:gallery, engine line pages (plan #68 §5, T05-004, T05-005, T02-029, T02-030, VIZ-002):
//! the ten pages against the committed PNGs (mean ꟻLIP ≤ 0.005), T1 = T2 and repeat renders
//! byte-equal, on the pinned lavapipe. `GOLDEN_UPDATE=1` writes the baselines instead.
mod common;

use common::*;
use dash_golden::{
    Image, PAGE_CSS, flip_mean, goldens_dir, manual_range, pages, pinned_driver, render_page,
};
use dash_gpu::Tier;

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
