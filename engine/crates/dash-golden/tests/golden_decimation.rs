//! golden:decimation-ref (plan #68 §5, A.4 with A.15.2; T02-015, ADR-0014 §4 note, T02-014): the
//! engine render against the independent reference: (1) A ⊆ B, (2) B ⊆ R⁺, (3) gap bands of F3,
//! (4) interpolation in F1b, (5) the F4a far crossing, (6) the F4b segment.
mod common;

use common::*;
use dash_golden::{Image, RefFrame, reference_mask};
use dash_gpu::Tier;
use pulsus_synth::reference::{RefFixture, f1a, f1b, f2, f3, f4a, f4b};

fn check(fx: &RefFixture, dpr: f32, img: &Image, f: &RefFrame) {
    let tag = format!("{} @{dpr}", fx.name);
    let m = reference_mask(&fx.chunk, f);
    // (1) every in-plot sample pixel is covered.
    let missing: Vec<_> = m.a.iter().filter(|(x, y)| !img.covered(*x, *y)).take(5).collect();
    assert!(missing.is_empty(), "{tag}: (1) uncovered {missing:?}");
    // (2) nothing outside R⁺.
    let mut stray = Vec::new();
    for y in 0..img.h {
        for x in 0..img.w {
            if img.covered(x, y) && !m.r_plus[(y * img.w + x) as usize] {
                stray.push((x, y));
            }
        }
    }
    assert!(stray.is_empty(), "{tag}: (2) {} stray pixels, first {:?}", stray.len(), &stray[..stray.len().min(5)]);
    let d = f64::from(dpr);
    let dev_cols = |c: f64| ((PLOT[0] + c) * d).floor() as u32..((PLOT[0] + c + 1.0) * d).ceil() as u32;
    match fx.name {
        "F3" => {
            // (3) rows between two runs, beyond a dot's reach (radius + AA + 1 px), are empty in
            // the column and its neighbours.
            let reach = 1.5 * d + 0.5 + 1.0;
            let runs: [(f64, &[(f64, f64)]); 2] = [
                (300.0, &[(10.0, 10.2), (50.0, 50.3), (89.8, 90.0)]),
                (500.0, &[(10.0, 10.0), (30.0, 30.0), (50.0, 50.0), (70.0, 70.1), (90.0, 90.2)]),
            ];
            for (c, rs) in runs {
                for pair in rs.windows(2) {
                    let (below_top, above_bottom) = (f.y(pair[0].1) * d, f.y(pair[1].0) * d);
                    let (y0, y1) = ((above_bottom + reach).ceil() as u32, (below_top - reach).floor() as u32);
                    assert!(y1 > y0 + 10, "{tag}: band {y0}..{y1}");
                    for x in dev_cols(c - 1.0).start..dev_cols(c + 1.0).end {
                        for y in y0..y1 {
                            assert!(!img.covered(x, y), "{tag}: (3) column {c} gap pixel ({x}, {y})");
                        }
                    }
                }
            }
        }
        "F1b" => {
            // (4) segments interpolate: covered pixels exist beyond the column's sample rows.
            let mut rows: Vec<Option<(f64, f64)>> = vec![None; 1000];
            for (k, v) in fx.chunk.values.iter().enumerate() {
                let Some(c) = (match &fx.chunk.time {
                    dash_wire::TimeAxis::Explicit { t_ms } => f.col(t_ms[k]),
                    dash_wire::TimeAxis::Grid { .. } => None,
                }) else {
                    continue;
                };
                let y = f.y(*v) * d;
                let e = rows[c as usize].get_or_insert((y, y));
                *e = (e.0.min(y), e.1.max(y));
            }
            let mut outside = 0;
            for c in 0..1000u32 {
                for x in dev_cols(f64::from(c)) {
                    for y in 0..img.h {
                        let beyond = rows[c as usize].is_none_or(|(lo, hi)| f64::from(y) + 3.0 < lo || f64::from(y) > hi + 3.0);
                        if img.covered(x, y) && beyond {
                            outside += 1;
                        }
                    }
                }
            }
            assert!(outside > 0, "{tag}: (4) no interpolated pixel");
        }
        "F4a" => {
            // (5) the crossing is at plot.x + 300.5 (not 450.5) and spans every plot row.
            let x_c = (PLOT[0] + 300.5) * d;
            let tol = 0.75 * (d + 1.0);
            let (px0, px1, py0, py1) = f.device_plot();
            for y in py0..py1 {
                let mut any = false;
                for x in px0..px1 {
                    if img.covered(x, y) {
                        any = true;
                        assert!((f64::from(x) + 0.5 - x_c).abs() <= tol, "{tag}: (5) pixel ({x}, {y}) off the crossing {x_c}");
                    }
                }
                assert!(any, "{tag}: (5) row {y} empty");
            }
        }
        "F4b" => {
            // (6) every device column along S has a covered pixel within tol of S.
            let tol = 0.75 * (d + 1.0);
            let a = ((PLOT[0] + 100.5) * d, f.y(0.2) * d);
            let b = ((PLOT[0] + 800.5) * d, f.y(0.7) * d);
            for x in (a.0.ceil() as u32)..(b.0.floor() as u32) {
                let near = (0..img.h).any(|y| {
                    img.covered(x, y) && dash_golden::reference::dist((f64::from(x) + 0.5, f64::from(y) + 0.5), a, b) <= tol
                });
                assert!(near, "{tag}: (6) column {x} has no pixel on S");
            }
        }
        _ => {}
    }
}

fn run(fixtures: &[RefFixture], structural: bool) {
    let (t1, t2) = (ctx(Tier::T1), ctx(Tier::T2));
    for fx in fixtures {
        for dpr in [1.0f32, 2.0] {
            let list = list_of(fx, dpr);
            let f = frame_of(fx, dpr);
            let a = render(&t1, &list);
            let b = render(&t2, &list);
            assert!(a == b, "{} @{dpr}: T1 and T2 differ", fx.name);
            if structural {
                check(fx, dpr, &a, &f);
            } else {
                let mut light = fx.clone();
                light.name = "volume";
                check(&light, dpr, &a, &f);
            }
        }
    }
}

#[test]
fn golden_decimation_ref() {
    let fixtures = [
        ok(f1a(100, 10_000), "F1a"),
        ok(f1b(), "F1b"),
        ok(f2(100, 10_000), "F2"),
        ok(f3(), "F3"),
        ok(f4a(), "F4a"),
        ok(f4b(), "F4b"),
    ];
    run(&fixtures, true);
}

/// Nightly volume: 10⁸ points (F1a and F2 at 10⁶ per series), assertions (1) and (2).
#[test]
#[ignore]
fn golden_decimation_full() {
    run(&[ok(f1a(100, 1_000_000), "F1a"), ok(f2(100, 1_000_000), "F2")], false);
}
