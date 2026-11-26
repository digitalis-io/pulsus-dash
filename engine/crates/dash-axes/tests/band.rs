//! unit:held-band, axis part (plan #68 §5, #93 §4.2a, A.13 F2, T02-011): under `Band::Fixed` the
//! plot depends only on (kind, size, band); labels that do not fit are flagged.
use dash_axes::{Band, VisKind, label_width, value_axis};
use dash_scales::Range64;
use dash_units::Unit;

pub fn cases() -> Vec<(f64, f64, Option<Range64>)> {
    let data = [(0.0, 30.0), (0.0, 2e-5), (-1e-13, 0.0), (0.0, 1e21)];
    let mut out = Vec::new();
    for (lo, hi) in data {
        out.push((lo, hi, None));
        for c in [0.0, 1.0, 1234.5, 1e6] {
            out.push((
                lo,
                hi,
                Some(Range64 {
                    lo: c,
                    hi: c + 1e-5,
                }),
            ));
        }
    }
    out
}

#[test]
fn fixed_band_holds_the_plot() {
    let cases = cases();
    assert_eq!(cases.len(), 20);
    let mut plots = Vec::new();
    let (mut below, mut above, mut moved) = (0, 0, false);
    let first_measured = value_axis(
        VisKind::Line,
        1118.0,
        240.0,
        cases[0].0,
        cases[0].1,
        cases[0].2,
        &Unit::None,
        Band::Measure,
        0.0,
    );
    for (lo, hi, manual) in &cases {
        let ax = value_axis(
            VisKind::Line,
            1118.0,
            240.0,
            *lo,
            *hi,
            *manual,
            &Unit::None,
            Band::Fixed(42.0),
            0.0,
        );
        plots.push(ax.plot);
        for l in &ax.labels {
            assert_eq!(
                l.fits,
                label_width(std::slice::from_ref(&l.text)) <= 42.0,
                "{:?}",
                l.text
            );
        }
        let measured = value_axis(
            VisKind::Line,
            1118.0,
            240.0,
            *lo,
            *hi,
            *manual,
            &Unit::None,
            Band::Measure,
            0.0,
        );
        if measured.band_w < 42.0 {
            below += 1;
        } else if measured.band_w > 42.0 {
            above += 1;
        }
        if measured.plot.x != first_measured.plot.x {
            moved = true;
        }
    }
    assert!(
        below > 0 && above > 0,
        "measured bands {below} below and {above} above 42 px"
    );
    assert!(moved, "Band::Measure never moved plot.x (precondition)");
    for p in &plots {
        assert_eq!(p.x.to_bits(), plots[0].x.to_bits());
        assert_eq!(p.width.to_bits(), plots[0].width.to_bits());
        assert_eq!(*p, plots[0]);
    }
}
