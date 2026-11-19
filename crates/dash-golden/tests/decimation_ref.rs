#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `golden:decimation-ref` (T05 §4.2, VIZ-006, T02-015): plan #24 tests 38–44. Run by the
//! `golden` gate: `cargo test --release -p dash-golden -- --ignored --test-threads=1`.

use std::sync::OnceLock;

use dash_golden::{
    Headless, LineData, Render, View, assert_zero_diff, frame, records, render, render_mask,
};
use dash_gpu::Tier;
use dash_marks::line::DecimatePath::{Compute, Fragment};
use dash_marks::line::FRAGMENT_TARGET_BYTES;
use dash_scales::lod::{
    NULL_BITS, OVERFLOW_BITS, Prepared, Pyramid, build_pyramid, decimate_series, prepare, rel_bits,
};
use dash_scales::raster::{Mask, mask_diff, raw_mask, record_mask};
use dash_scene::line::{LayerInfo, LineFrame};
use pulsus_synth::SplitMix64;
use pulsus_synth::line::{LINE_1E8, LINE_GAPPY, LINE_SMALL, LinePreset};

const CSS: (u32, u32) = (1_056, 432);

fn webgpu() -> &'static Headless {
    static H: OnceLock<Headless> = OnceLock::new();
    H.get_or_init(|| Headless::lavapipe(Tier::WebGpu).expect("lavapipe"))
}

/// Seed-24 data of a preset, generated once per test binary.
fn synth(p: &LinePreset) -> &'static LineData {
    static DATA: OnceLock<Vec<(&'static str, LineData)>> = OnceLock::new();
    let all = DATA.get_or_init(|| {
        [LINE_1E8, LINE_SMALL, LINE_GAPPY]
            .iter()
            .map(|p| (p.name, LineData::synth(24, p)))
            .collect()
    });
    &all.iter().find(|(n, _)| *n == p.name).unwrap().1
}

fn pyramids(d: &LineData) -> Vec<Pyramid> {
    d.bits
        .iter()
        .map(|b| {
            let mut p = Pyramid::default();
            build_pyramid(b, &mut p);
            p
        })
        .collect()
}

/// Views V1–V5 of plan §5 at `dpr` on the 1 056 × 432 CSS canvas.
fn view(d: &LineData, v: u8, dpr: f32) -> View {
    let base = View {
        css: CSS,
        dpr,
        x: None,
        y: None,
    };
    let w = f64::from(frame(d, &base).unwrap().plot.w);
    let step = d.layer.step_ms as f64;
    let n = f64::from(d.layer.n);
    let e = n * step;
    let v2 = (0.6 * e - e / 80.0, e / 40.0 / w);
    let x = match v {
        1 => None,
        2 => Some(v2),
        3 => {
            let m = step / 4.0;
            Some((n / 2.0 * step - 500.0 * m, m))
        }
        4 => Some((v2.0 + 0.37 * v2.1, v2.1)),
        _ => Some((0.5 * e / w, e / w)),
    };
    View { x, ..base }
}

fn raw_of(d: &LineData, f: &LineFrame, i: usize) -> Mask {
    let u = &f.uniforms;
    let ym = dash_scales::lod::YMap {
        d: u.d(i as u32),
        a: u.a_y,
    };
    raw_mask(
        &d.bits[i],
        &f.columns.xmap,
        &ym,
        d.layer.n,
        f.plot.w,
        f.plot.h,
    )
}

/// `(canvas width, height)` in device px.
fn canvas(v: &View) -> (u32, u32) {
    let f = |c: u32| (c as f32 * v.dpr).round() as u32;
    (f(v.css.0), f(v.css.1))
}

/// The RGBA of plot pixel `(c, r)` (r from the plot bottom) in a visual image.
fn pixel(img: &[u8], v: &View, f: &LineFrame, c: u32, r: u32) -> [u8; 4] {
    let (w, h) = canvas(v);
    let x = f.plot.x0 as u32 + c;
    let y = h - 1 - (f.plot.y0 as u32 + r);
    let at = 4 * (y * w + x) as usize;
    [img[at], img[at + 1], img[at + 2], img[at + 3]]
}

/// A one-series layer of `values` (NaN = NULL), `step` ms apart from `start`.
fn custom(values: &[f64], start: i64, step: i64) -> LineData {
    let valid = |k: usize| !values[k].is_nan();
    let pr = prepare(values, &valid);
    let mut bits = vec![0u32; values.len()];
    rel_bits(values, &valid, pr.v_ref, &mut bits);
    LineData {
        layer: LayerInfo {
            start_ms: start,
            step_ms: step,
            n: values.len() as u32,
            requested: 1,
            held: 1,
        },
        bits: vec![bits],
        prepared: vec![pr],
    }
}

fn lit(img: &[u8]) -> f64 {
    let n = img.chunks(4).filter(|p| p[0] > 0).count();
    n as f64 / (img.len() / 4) as f64
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn lavapipe_pinned() {
    let h = webgpu();
    assert!(h.info.name.contains("llvmpipe"), "{:?}", h.info);
    let tools =
        std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../ci/tools.toml"))
            .unwrap();
    let upstream = tools
        .lines()
        .find_map(|l| l.strip_prefix("mesa_upstream = \""))
        .and_then(|l| l.split('"').next())
        .unwrap();
    assert!(
        h.info.driver_info.contains(upstream),
        "driver {:?}, pinned Mesa {upstream}",
        h.info.driver_info
    );
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn gpu_records_match_cpu() {
    let h = webgpu();
    for p in [LINE_SMALL, LINE_GAPPY] {
        let d = synth(&p);
        let pyr = pyramids(d);
        for v in 1..=5 {
            let vw = view(d, v, 1.0);
            let f = frame(d, &vw).unwrap();
            let cpu: Vec<_> = (0..d.bits.len())
                .map(|i| decimate_series(&d.bits[i], &pyr[i], &f.columns))
                .collect();
            for path in [Compute, Fragment] {
                let gpu = records(h, d, &vw, path);
                assert_eq!(gpu.len(), cpu.len());
                for (i, (g, c)) in gpu.iter().zip(&cpu).enumerate() {
                    assert!(g == c, "{} V{v} {path:?} series {i}", p.name);
                }
            }
            if p.name == LINE_GAPPY.name && v == 1 {
                let all: Vec<_> = cpu.iter().flatten().collect();
                assert!(all.iter().any(|r| r.a[2] == OVERFLOW_BITS));
                assert!(
                    all.iter()
                        .any(|r| r.a[2] != NULL_BITS && r.a[2] != OVERFLOW_BITS)
                );
            }
        }
    }
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn decimation_ref_zero_diff() {
    let h = webgpu();
    for p in [LINE_1E8, LINE_GAPPY] {
        let d = synth(&p);
        let s = d.bits.len();
        let pyr = pyramids(d);
        for v in 1..=5 {
            for dpr in [1.0, 2.0] {
                let vw = view(d, v, dpr);
                let f = frame(d, &vw).unwrap();
                let at = format!("{} V{v} DPR {dpr}", p.name);
                let mut merged = Mask::new(f.plot.w, f.plot.h);
                let mut raws = Vec::with_capacity(s);
                for i in 0..s {
                    let raw = raw_of(d, &f, i);
                    let ym = dash_scales::lod::YMap {
                        d: f.uniforms.d(i as u32),
                        a: f.uniforms.a_y,
                    };
                    let recs = decimate_series(&d.bits[i], &pyr[i], &f.columns);
                    assert!(
                        record_mask(&recs, &f.columns, &d.bits[i], &ym, f.plot.h) == raw,
                        "{at}: record_mask of series {i}"
                    );
                    merged.union(&raw);
                    if i == 0 || i == s - 1 {
                        raws.push((i as u32, raw));
                    }
                }
                assert!(merged.count() > 0, "{at}");
                for path in [Compute, Fragment] {
                    let got = render_mask(h, d, &vw, Render::Decimated(path), None);
                    assert_eq!(mask_diff(&got, &merged), (0, 0), "{at} {path:?}");
                    assert_zero_diff(&got, &merged);
                    for (i, raw) in &raws {
                        let one = render_mask(h, d, &vw, Render::Decimated(path), Some(*i));
                        assert_eq!(mask_diff(&one, raw), (0, 0), "{at} {path:?} series {i}");
                    }
                }
                let img = render(h, d, &vw, Render::Decimated(Compute), None);
                for r in 0..f.plot.h {
                    for c in 0..f.plot.w {
                        if merged.get(c, r) {
                            assert!(
                                pixel(&img, &vw, &f, c, r)[0] > 0,
                                "{at}: pixel ({c}, {r}) unlit"
                            );
                        }
                    }
                }
            }
        }
    }
}

/// The LINE_SMALL V2 GPU mask and its raw mask.
fn small_v2() -> (Mask, Mask) {
    let d = synth(&LINE_SMALL);
    let vw = view(d, 2, 1.0);
    let f = frame(d, &vw).unwrap();
    let mut raw = Mask::new(f.plot.w, f.plot.h);
    for i in 0..d.bits.len() {
        raw.union(&raw_of(d, &f, i));
    }
    (
        render_mask(webgpu(), d, &vw, Render::Decimated(Compute), None),
        raw,
    )
}

#[test]
#[ignore = "golden gate (lavapipe)"]
#[should_panic(expected = "zero-diff failed: (missing, extra) = (0, 1)")]
fn zero_diff_rejects_extra() {
    let (mut got, raw) = small_v2();
    let (c, r) = (0..raw.h)
        .flat_map(|r| (0..raw.w).map(move |c| (c, r)))
        .find(|(c, r)| !raw.get(*c, *r))
        .unwrap();
    got.set(c, r);
    assert_eq!(mask_diff(&got, &raw), (0, 1));
    assert_zero_diff(&got, &raw);
}

#[test]
#[ignore = "golden gate (lavapipe)"]
#[should_panic(expected = "zero-diff failed: (missing, extra) = (1, 0)")]
fn zero_diff_rejects_missing() {
    let (mut got, raw) = small_v2();
    let (c, r) = (0..raw.h)
        .flat_map(|r| (0..raw.w).map(move |c| (c, r)))
        .find(|(c, r)| raw.get(*c, *r))
        .unwrap();
    got.clear(c, r);
    assert_eq!(mask_diff(&got, &raw), (1, 0));
    assert_zero_diff(&got, &raw);
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn mask_pass_exact_segments() {
    let mut rng = SplitMix64::new(5);
    let values: Vec<f64> = (0..10_000)
        .map(|_| {
            let v = (rng.next_f64() * 2.0 - 1.0) * f64::from(1u32 << 20);
            if rng.next_f64() < 0.05 { f64::NAN } else { v }
        })
        .collect();
    let d = custom(&values, 0, 10);
    for beta in [1.0 / 16.0, 0.3, 7.0] {
        let m = beta * 10.0;
        let vw = View {
            css: CSS,
            dpr: 1.0,
            x: Some((5_000.0 * 10.0 - 500.0 * m, m)),
            y: Some((0.0, 1.0)),
        };
        let f = frame(&d, &vw).unwrap();
        let raw = raw_of(&d, &f, 0);
        assert!(raw.count() > 0);
        let got = render_mask(webgpu(), &d, &vw, Render::Reference, None);
        assert_eq!(mask_diff(&got, &raw), (0, 0), "β {beta}");
    }
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn draw_parity() {
    let h = webgpu();
    for p in [LINE_1E8, LINE_GAPPY] {
        let d = synth(&p);
        for v in 1..=5 {
            for dpr in [1.0, 2.0] {
                let vw = view(d, v, dpr);
                let at = format!("{} V{v} DPR {dpr}", p.name);
                let compute = render(h, d, &vw, Render::Decimated(Compute), None);
                assert!(lit(&compute) > 0.01, "{at}: lit {}", lit(&compute));
                assert!(
                    render(h, d, &vw, Render::Reference, None) == compute,
                    "{at}: reference"
                );
                assert!(
                    render(h, d, &vw, Render::Decimated(Fragment), None) == compute,
                    "{at}: fragment"
                );
            }
        }
    }
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn fragment_within_webgl2_limits() {
    let t2 = Headless::lavapipe(Tier::WebGl2).expect("lavapipe");
    assert!(FRAGMENT_TARGET_BYTES <= t2.device.limits().max_color_attachment_bytes_per_sample);
    assert_eq!(FRAGMENT_TARGET_BYTES, 32);
    let d = synth(&LINE_SMALL);
    let vw = view(d, 2, 1.0);
    let scope = t2.device.push_error_scope(wgpu::ErrorFilter::Validation);
    let img = render(&t2, d, &vw, Render::Decimated(Fragment), None);
    assert!(
        pollster::block_on(scope.pop()).is_none(),
        "validation error on T2 limits"
    );
    assert!(lit(&img) > 0.01);
    assert!(img == render(webgpu(), d, &vw, Render::Decimated(Compute), None));
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn record_tiling() {
    let d = synth(&LINE_SMALL);
    let vw = view(d, 2, 2.0);
    assert_eq!(frame(d, &vw).unwrap().columns.slots(), 2_010);
    for path in [Compute, Fragment] {
        let whole = render(webgpu(), d, &vw, Render::Decimated(path), None);
        let tiled = render(webgpu(), d, &vw, Render::Decimated(path), Some(512));
        assert!(lit(&whole) > 0.01);
        assert!(whole == tiled, "{path:?}");
    }
}

fn decimated(d: &LineData, vw: &View) -> Vec<u8> {
    let img = render(webgpu(), d, vw, Render::Decimated(Compute), None);
    assert!(img == render(webgpu(), d, vw, Render::Reference, None));
    img
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn null_breaks_golden() {
    let mut values: Vec<f64> = (0..40).map(|k| if k <= 20 { 0.0 } else { 100.0 }).collect();
    values[19] = f64::NAN;
    values[21] = f64::NAN;
    let d = custom(&values, 0, 10);
    let vw = View {
        css: (72, 432),
        dpr: 1.0,
        x: Some((0.0, 25.0)),
        y: None,
    };
    let f = frame(&d, &vw).unwrap();
    assert_eq!(f.plot.w, 16);
    let x = f.columns.xmap;
    assert_eq!((x.col(20), x.col(21), x.col(22)), (8, 8, 8));
    let img = decimated(&d, &vw);
    let row = |v: f64| {
        let ym = dash_scales::lod::YMap {
            d: f.uniforms.d(0),
            a: f.uniforms.a_y,
        };
        ym.y(dash_scales::lod::to_bits(v, true, d.prepared[0].v_ref))
            .floor() as u32
    };
    assert!(pixel(&img, &vw, &f, 8, row(0.0))[0] > 0, "y(0)");
    assert!(pixel(&img, &vw, &f, 8, row(100.0))[0] > 0, "y(100)");
    assert_eq!(pixel(&img, &vw, &f, 8, row(50.0))[0], 0, "y(50) is a gap");
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn spike_visible_golden() {
    let mut values = vec![0.0f64; 1_000_000];
    values[543_210] = 100.0;
    let d = custom(&values, 0, 1);
    assert_eq!(
        d.prepared[0],
        Prepared {
            v_ref: 50.0,
            min: 0.0,
            max: 100.0
        }
    );
    let vw = View {
        css: CSS,
        dpr: 1.0,
        x: None,
        y: None,
    };
    let f = frame(&d, &vw).unwrap();
    let img = decimated(&d, &vw);
    let c = f.columns.xmap.col(543_210) as u32;
    let ym = dash_scales::lod::YMap {
        d: f.uniforms.d(0),
        a: f.uniforms.a_y,
    };
    let r = ym.y(50.0f32.to_bits()).floor() as u32;
    assert!(pixel(&img, &vw, &f, c, r)[0] > 0, "spike at ({c}, {r})");
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn adjacency_1ms_golden() {
    let values: Vec<f64> = (0..1_000).map(|k| f64::from(k % 2)).collect();
    let d = custom(&values, 1_700_000_000_000, 1);
    let vw = View {
        css: (856, 432),
        dpr: 1.0,
        x: Some((400.03, 1.0 / 16.0)),
        y: None,
    };
    let f = frame(&d, &vw).unwrap();
    assert_eq!((f.plot.w, f.plot.h), (800, 400));
    let img = decimated(&d, &vw);
    let x = f.columns.xmap;
    let ym = dash_scales::lod::YMap {
        d: f.uniforms.d(0),
        a: f.uniforms.a_y,
    };
    let visible: Vec<u32> = (0..1_000)
        .filter(|k| (0..800).contains(&x.col(*k)))
        .take(21)
        .collect();
    assert_eq!(visible.len(), 21);
    for w in visible.windows(2) {
        let k = w[0];
        assert_eq!(x.col(w[1]) - x.col(k), 16);
        let r = ym.y(d.bits[0][k as usize]).floor() as u32;
        assert!(pixel(&img, &vw, &f, x.col(k) as u32, r)[0] > 0, "k {k}");
    }
}

#[test]
#[ignore = "golden gate (lavapipe)"]
fn same_seed_same_pixels() {
    let a = Headless::lavapipe(Tier::WebGpu).expect("lavapipe");
    let b = Headless::lavapipe(Tier::WebGpu).expect("lavapipe");
    let d = synth(&LINE_SMALL);
    let vw = view(d, 2, 1.0);
    let x = render(&a, d, &vw, Render::Decimated(Compute), None);
    let y = render(&b, d, &vw, Render::Decimated(Compute), None);
    assert!(lit(&x) > 0.01);
    assert!(x == y);
    let other = LineData::synth(25, &LINE_SMALL);
    assert!(
        render(
            &a,
            &other,
            &view(&other, 2, 1.0),
            Render::Decimated(Compute),
            None
        ) != x
    );
}
