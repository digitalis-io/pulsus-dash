//! unit:held-band, build part (plan #68 §5, #93 §4.2a, A.13 F2): under `Band::Fixed` the draw list
//! and the summary keep one plot rect whatever the labels.
mod common;

use common::*;
use dash_marks::desc::MarkItem;
use dash_scene::{Band, Camera, LineSpec, PlotCamera, Range64, ValueRange, VisSpec, build};
use dash_units::Unit;

#[test]
fn fixed_band_holds_the_built_plot() {
    let data = [(0.0, 30.0), (0.0, 2e-5), (-1e-13, 0.0), (0.0, 1e21)];
    let window = Range64 { lo: T0, hi: T0 + 10_000.0 };
    let mut plots = Vec::new();
    let mut moved = false;
    let mut first_measured = None;
    for (lo, hi) in data {
        let manuals = [None, Some(0.0), Some(1.0), Some(1234.5), Some(1e6)];
        for m in manuals {
            let mut spec = LineSpec::new(Unit::None);
            spec.value_range = m.map(|c| ValueRange { min: c, max: c + 1e-5 });
            for band in [Band::Fixed(42.0), Band::Measure] {
                let mut v = viewport(chunk_of(&[lo, hi, lo]), spec.clone(), window, band);
                v.camera = Camera::Plot2D(PlotCamera::idle(window, &VisSpec::Line(spec.clone())));
                let (list, summary) = build(&v);
                let Some(summary) = summary else { panic!("no summary for {lo}..{hi} {m:?}") };
                if band == Band::Measure {
                    let x = summary.plot.x;
                    if *first_measured.get_or_insert(x) != x {
                        moved = true;
                    }
                    continue;
                }
                let guides = list.items.iter().find_map(|i| match i {
                    MarkItem::Guides { plot, .. } => Some(*plot),
                    _ => None,
                });
                plots.push((summary.plot, guides));
            }
        }
    }
    assert_eq!(plots.len(), 20);
    assert!(moved, "Band::Measure never moved plot.x (precondition)");
    for p in &plots {
        assert_eq!(p.0, plots[0].0);
        assert!(p.1.is_some());
        assert_eq!(p.1, plots[0].1);
    }
}
