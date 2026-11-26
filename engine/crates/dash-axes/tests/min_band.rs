//! unit:min-value-band (plan #68 C1 deviation, T02-011): a measured value band is at least the
//! width of the widest compact label (as the Canvas 2D engine's `minValueBand`), so the engine's
//! plot equals Canvas 2D's; a held band is used as it is.
use dash_axes::{Band, VisKind, label_width, layout_plot, min_value_band, value_axis};
use dash_units::{TimeBase, Unit};

/// space 2 (8) + the chart tick (4) left of the plot; space 2 right of it.
const LEFT: f64 = 12.0;
const RIGHT: f64 = 8.0;

#[test]
fn the_minimum_band_is_the_widest_compact_label() {
    // `-88.8E` (6 characters) and `-88.8E B` / ` s` / ` %` (8) at 6.6 px each, rounded up.
    let cases = [
        (Unit::None, 40.0),
        (Unit::Bytes, 53.0),
        (Unit::Time { base: TimeBase::S }, 53.0),
        (Unit::Percent, 53.0),
    ];
    for (unit, want) in &cases {
        assert_eq!(min_value_band(VisKind::Line, unit), *want, "{unit:?}");
        assert_eq!(min_value_band(VisKind::Stat, unit), 0.0, "{unit:?}");
    }
}

#[test]
fn a_measured_band_is_at_least_the_minimum() {
    let (w, h) = (1118.0, 240.0);
    // Short labels (0 … 1): the minimum band sets the plot.
    for (unit, min) in [
        (Unit::None, 40.0),
        (Unit::Bytes, 53.0),
        (Unit::Time { base: TimeBase::S }, 53.0),
        (Unit::Percent, 53.0),
    ] {
        let a = value_axis(
            VisKind::Line,
            w,
            h,
            0.0,
            1.0,
            None,
            &unit,
            Band::Measure,
            0.0,
        );
        let texts: Vec<String> = a.labels.iter().map(|l| l.text.clone()).collect();
        assert!(label_width(&texts) < min, "{unit:?}: {texts:?}");
        assert_eq!(a.band_w, min, "{unit:?}");
        assert_eq!(
            (a.plot.x, a.plot.width),
            (min + LEFT, w - min - LEFT - RIGHT),
            "{unit:?}"
        );
        assert_eq!(a.plot, layout_plot(VisKind::Line, w, h, min, 0.0));
    }
    // Long labels: the measured width wins.
    let a = value_axis(
        VisKind::Line,
        w,
        h,
        0.0,
        1.1e-4,
        None,
        &Unit::None,
        Band::Measure,
        0.0,
    );
    let texts: Vec<String> = a.labels.iter().map(|l| l.text.clone()).collect();
    let measured = label_width(&texts);
    assert!(measured > 40.0, "{texts:?}");
    assert_eq!(a.band_w, measured);
    assert_eq!(a.plot.x, measured + LEFT);
}

#[test]
fn a_held_band_is_used_as_it_is() {
    let a = value_axis(
        VisKind::Line,
        1118.0,
        240.0,
        0.0,
        1.0,
        None,
        &Unit::Bytes,
        Band::Fixed(30.0),
        0.0,
    );
    assert_eq!(a.band_w, 30.0);
    assert_eq!(
        (a.plot.x, a.plot.width),
        (42.0, 1118.0 - 30.0 - LEFT - RIGHT)
    );
}
