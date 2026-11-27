//! `line_stats_fit` (#304 §A.8): the line's summary and auto domain over `Viewport.fit` only;
//! `crossfade_alpha` (ADR-0039): a fade draws the previous line under the new one, each composited
//! at its share of the 150 ms, with the axes of the new data.
mod common;

use std::sync::Arc;

use common::{T0, chunk_of, viewport};
use dash_marks::desc::MarkItem;
use dash_scene::{Band, Fade, LineSpec, Range64, build};
use dash_units::Unit;

/// 1 s apart: 5 everywhere, 10 at 30 s (inside the fit) and a spike of 100 at 100 s (outside).
fn spiky() -> Vec<f64> {
    (0..121)
        .map(|k| match k {
            30 => 10.0,
            100 => 100.0,
            _ => 5.0,
        })
        .collect()
}

#[test]
fn line_stats_fit() {
    let window = Range64 {
        lo: T0,
        hi: T0 + 60_000.0,
    };
    let mut v = viewport(
        chunk_of(&spiky()),
        LineSpec::new(Unit::None),
        window,
        Band::Measure,
    );
    let all = build(&v).1.map(|s| s.max);
    assert_eq!(all, Some(Some(100.0)));
    v.fit = Some(window);
    let s = build(&v).1;
    assert_eq!(s.as_ref().and_then(|s| s.max), Some(10.0));
    assert_eq!(s.as_ref().and_then(|s| s.min), Some(5.0));
    let axis_max = s
        .and_then(|s| s.value_axis)
        .map_or(f64::INFINITY, |a| a.max);
    assert!(axis_max < 100.0, "auto domain {axis_max} over the fit only");
}

#[test]
fn crossfade_alpha() {
    let window = Range64 {
        lo: T0,
        hi: T0 + 120_000.0,
    };
    let prev = Arc::new(chunk_of(&[1.0; 121]));
    let mut v = viewport(
        chunk_of(&spiky()),
        LineSpec::new(Unit::None),
        window,
        Band::Measure,
    );
    let (plain, plain_summary) = build(&v);
    v.fade = Some(Fade {
        prev: prev.clone(),
        prev_fit: None,
        started_ms: 1_000.0,
        now_ms: 1_075.0,
    });
    let (list, summary) = build(&v);
    let lines: Vec<_> = list
        .items
        .iter()
        .filter_map(|i| match i {
            MarkItem::Line {
                chunk, emphasis, ..
            } => Some((chunk.clone(), emphasis.clone())),
            _ => None,
        })
        .collect();
    assert_eq!(lines.len(), 2, "the previous line and the new one");
    assert!(Arc::ptr_eq(&lines[0].0, &prev), "the previous line first");
    let alpha = |e: &Option<dash_marks::desc::Emphasis>| e.as_ref().map(|e| e.dimmed);
    assert!((alpha(&lines[0].1).unwrap_or(1.0) - 0.5).abs() < 1e-6);
    assert!((alpha(&lines[1].1).unwrap_or(1.0) - 0.5).abs() < 1e-6);
    assert!(lines.iter().all(|(_, e)| e.as_ref().is_some_and(|e| e.matched.iter().all(|m| !m))));
    // The axes and the summary are the new data's.
    assert_eq!(summary, plain_summary);
    let guides = |l: &dash_marks::desc::DrawList| {
        l.items
            .iter()
            .filter(|i| matches!(i, MarkItem::Guides { .. }))
            .count()
    };
    assert_eq!(guides(&list), guides(&plain));
    // Past 150 ms the fade is over: one line, no emphasis.
    v.fade = Some(Fade {
        prev,
        prev_fit: None,
        started_ms: 1_000.0,
        now_ms: 1_150.0,
    });
    let (done, _) = build(&v);
    assert_eq!(
        done.items
            .iter()
            .filter(|i| matches!(i, MarkItem::Line { .. }))
            .count(),
        1
    );
}
