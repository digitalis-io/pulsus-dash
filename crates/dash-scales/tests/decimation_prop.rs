#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Decimation properties (unit:decimation-prop, T02-014, T02-015, VIZ-005, VIZ-006): plan #24
//! tests 9, 11–15.

use dash_scales::lod::{
    Columns, EMPTY, MARGIN, NULL_BITS, OVERFLOW_BITS, Pyramid, SlotRecord, XMap, build_pyramid,
    decimate_series, prepare, reference_passes, rel_bits, slot_record, to_bits,
};
use pulsus_synth::SplitMix64;
use pulsus_synth::line::{custom, series};

/// Random test data: a walk with NULL singles and runs, ±1e6 spikes and isolated samples.
fn data(rng: &mut SplitMix64, n: u32, null_p: f64) -> Vec<u32> {
    let mut bits = Vec::with_capacity(n as usize);
    let mut v = 0.0f64;
    let mut nulls = 0u32;
    for k in 0..n {
        v += rng.next_f64() - 0.5;
        let r = rng.next_f64();
        if nulls > 0 {
            nulls -= 1;
            bits.push(NULL_BITS);
            continue;
        }
        if r < null_p {
            // Mostly single NULLs, sometimes runs up to 5 000.
            nulls = if rng.next_f64() < 0.8 {
                0
            } else {
                (rng.next_u64() % 5_000) as u32
            };
            bits.push(NULL_BITS);
        } else if r < null_p + 0.001 {
            let s = if rng.next_f64() < 0.5 { 1e6 } else { -1e6 };
            bits.push(to_bits(v + s, true, 0.0));
        } else if r < null_p + 0.002 && k > 0 && k + 1 < n {
            // An isolated sample: NULL, value, NULL.
            if let Some(b) = bits.last_mut() {
                *b = NULL_BITS;
            }
            bits.push(to_bits(v, true, 0.0));
            nulls = 1;
        } else {
            bits.push(to_bits(v, true, 0.0));
        }
    }
    bits
}

fn f(b: u32) -> f32 {
    f32::from_bits(b)
}

/// The record of `[lo, hi)` by a plain scan (plan §3.3), with `next` as given.
fn naive(bits: &[u32], lo: u32, hi: u32, next: u32) -> SlotRecord {
    if lo >= hi {
        return EMPTY;
    }
    let mut runs: Vec<(u32, u32)> = Vec::new();
    let mut all: Option<(u32, u32)> = None;
    let mut open = false;
    let merge = |acc: Option<(u32, u32)>, b: u32| match acc {
        None => Some((b, b)),
        Some((mn, mx)) => Some((
            if f(b) < f(mn) { b } else { mn },
            if f(b) > f(mx) { b } else { mx },
        )),
    };
    for k in lo..hi {
        let b = bits[k as usize];
        if b == NULL_BITS {
            open = false;
            continue;
        }
        if open {
            let last = runs.len() - 1;
            runs[last] = merge(Some(runs[last]), b).unwrap();
        } else {
            runs.push((b, b));
            open = true;
        }
        all = merge(all, b);
    }
    let mut r = EMPTY;
    if runs.len() > 3 {
        let (mn, mx) = all.unwrap();
        r.a = [mn, mx, OVERFLOW_BITS, NULL_BITS];
    } else {
        let mut iv = [NULL_BITS; 6];
        for (i, (mn, mx)) in runs.iter().enumerate() {
            iv[2 * i] = *mn;
            iv[2 * i + 1] = *mx;
        }
        r.a = [iv[0], iv[1], iv[2], iv[3]];
        r.b[0] = iv[4];
        r.b[1] = iv[5];
    }
    r.b[2] = bits[hi as usize - 1];
    r.b[3] = next;
    r
}

fn pyramid(bits: &[u32]) -> Pyramid {
    let mut p = Pyramid::default();
    build_pyramid(bits, &mut p);
    p
}

#[test]
fn range_runs_match_naive() {
    let mut rng = SplitMix64::new(9);
    let mut overflow = 0;
    for case in 0..512 {
        let n = 1 + (rng.next_u64() % 70_000) as u32;
        let bits = data(&mut rng, n, 0.05);
        let p = pyramid(&bits);
        let a = (rng.next_u64() % u64::from(n + 1)) as u32;
        let b = (rng.next_u64() % u64::from(n + 1)) as u32;
        let (lo, hi) = (a.min(b), a.max(b));
        let got = slot_record(&bits, &p, lo, hi, false);
        let want = naive(&bits, lo, hi, NULL_BITS);
        assert_eq!(got, want, "case {case}: n {n} [{lo}, {hi})");
        overflow += usize::from(got.a[2] == OVERFLOW_BITS);
    }
    assert!(overflow > 100, "{overflow} overflow ranges");
}

#[test]
fn decimation_keeps_extremes() {
    let mut rng = SplitMix64::new(11);
    let step = 10.0;
    for case in 0..256 {
        let n = 2 + (rng.next_u64() % 19_999) as u32;
        let bits = data(&mut rng, n, 0.02);
        let p = pyramid(&bits);
        let plot_w = 50 + (rng.next_u64() % 550) as u32;
        // β = ms_per_px / step, log-uniform in [1/16, 400].
        let beta = (1.0f64 / 16.0) * 6400f64.powf(rng.next_f64());
        let ms_per_px = (beta * step).min(4.0 * f64::from(n) * step / f64::from(plot_w));
        let span = f64::from(plot_w) * ms_per_px;
        let e = f64::from(n) * step;
        let t_left = -span + rng.next_f64() * (e + span);
        let c = Columns::new(XMap::new(step, t_left, ms_per_px), n, plot_w);
        let recs = decimate_series(&bits, &p, &c);
        assert_eq!(recs.len() as u32, c.slots());
        let last = c.slots() - 1;
        for s in 0..c.slots() {
            let (lo, hi) = c.slot_range(s);
            let next = if hi < n && s != last && lo < hi {
                bits[hi as usize]
            } else {
                NULL_BITS
            };
            let want = naive(&bits, lo, hi, next);
            assert_eq!(recs[s as usize], want, "case {case} slot {s} [{lo}, {hi})");
            let valid: Vec<f32> = (lo..hi)
                .map(|k| bits[k as usize])
                .filter(|b| *b != NULL_BITS)
                .map(f)
                .collect();
            if let (Some(mn), Some(mx)) = (
                valid.iter().copied().reduce(f32::min),
                valid.iter().copied().reduce(f32::max),
            ) {
                let r = recs[s as usize];
                let ends: Vec<u32> = if r.a[2] == OVERFLOW_BITS {
                    vec![r.a[0], r.a[1]]
                } else {
                    vec![r.a[0], r.a[1], r.a[2], r.a[3], r.b[0], r.b[1]]
                };
                let present: Vec<f32> = ends
                    .into_iter()
                    .filter(|b| *b != NULL_BITS)
                    .map(f)
                    .collect();
                assert!(present.contains(&mn), "case {case} slot {s}: min {mn}");
                assert!(present.contains(&mx), "case {case} slot {s}: max {mx}");
            }
        }
    }
}

/// The records of every series of `custom(64, 50 000)` at seed 24, view V2, on `threads` threads.
fn decimate_all(threads: usize) -> Vec<Vec<SlotRecord>> {
    let preset = custom(64, 50_000);
    let n = preset.points;
    let step = preset.step_ms as f64;
    let e = f64::from(n) * step;
    let plot_w = 1_000;
    let ms_per_px = e / 40.0 / f64::from(plot_w);
    let c = Columns::new(XMap::new(step, 0.6 * e - e / 80.0, ms_per_px), n, plot_w);
    let ids: Vec<u32> = (0..preset.series).collect();
    let chunk = ids.len().div_ceil(threads);
    let mut out: Vec<Vec<SlotRecord>> = Vec::new();
    std::thread::scope(|scope| {
        let handles: Vec<_> = ids
            .chunks(chunk)
            .map(|part| {
                let c = &c;
                scope.spawn(move || {
                    part.iter()
                        .map(|&id| {
                            let s = series(24, &preset, id);
                            let pr = prepare(&s.values, &|k| s.valid[k]);
                            let mut bits = vec![0u32; n as usize];
                            rel_bits(&s.values, &|k| s.valid[k], pr.v_ref, &mut bits);
                            decimate_series(&bits, &pyramid(&bits), c)
                        })
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        for h in handles {
            out.extend(h.join().unwrap());
        }
    });
    out
}

#[test]
fn decimation_same_across_threads() {
    let one = decimate_all(1);
    assert_eq!(one.len(), 64);
    assert!(
        one.iter()
            .all(|r| r.len() == 1_000 + 2 * MARGIN as usize + 2)
    );
    assert!(one.iter().flatten().any(|r| r.a[0] != NULL_BITS));
    assert_eq!(decimate_all(2), one);
    assert_eq!(decimate_all(7), one);
}

#[test]
fn spike_survives_decimation() {
    let n = 1_000_000u32;
    let mut values = vec![0.0f64; n as usize];
    values[543_210] = 100.0;
    let pr = prepare(&values, &|_| true);
    assert_eq!(pr.v_ref, 50.0);
    let mut bits = vec![0u32; n as usize];
    rel_bits(&values, &|_| true, pr.v_ref, &mut bits);
    let c = Columns::new(XMap::new(1.0, 0.0, f64::from(n) / 1_000.0), n, 1_000);
    let recs = decimate_series(&bits, &pyramid(&bits), &c);
    let s = (0..c.slots())
        .find(|s| {
            let (lo, hi) = c.slot_range(*s);
            (lo..hi).contains(&543_210)
        })
        .unwrap();
    assert_eq!(recs[s as usize].a[1], 50.0f32.to_bits());
}

#[test]
fn adjacency_1ms_deepest_zoom() {
    let xm = XMap::new(1.0, 400.03, 1.0 / 16.0);
    let visible: Vec<u32> = (0..1_000u32)
        .filter(|k| (0..800).contains(&xm.col(*k)))
        .collect();
    assert!(visible.len() >= 49, "{}", visible.len());
    for w in visible.windows(2) {
        let (a, b) = (w[0], w[1]);
        assert!((xm.x(b) - xm.x(a) - 16.0).abs() <= 1e-3, "k {a}");
        assert_eq!(xm.col(b) - xm.col(a), 16, "k {a}");
    }
}

#[test]
fn reference_items() {
    let n = 40u32;
    let mut bits: Vec<u32> = (0..n).map(|k| (k as f32).to_bits()).collect();
    for k in [10, 11, 12, 19, 21] {
        bits[k] = NULL_BITS;
    }
    let c = Columns::new(XMap::new(10.0, 0.0, 25.0), n, 16);
    assert_eq!((c.k_l, c.k_r), (None, None));
    let passes = reference_passes(&bits, &c);
    assert_eq!(passes.len(), 3);
    let mut segments: Vec<u32> = Vec::new();
    let mut dots: Vec<u32> = Vec::new();
    for (recs, ks) in &passes {
        assert_eq!(recs.len() as u32, c.slots());
        assert_eq!(ks.len() as u32, c.slots());
        for (r, k) in recs.iter().zip(ks) {
            if *r == EMPTY {
                assert_eq!(*k, u32::MAX);
            } else if r.a[0] == NULL_BITS {
                assert_eq!(r.b[..2], [NULL_BITS; 2]);
                assert_eq!(r.b[2], bits[*k as usize]);
                assert_eq!(r.b[3], bits[*k as usize + 1]);
                segments.push(*k);
            } else {
                assert_eq!(
                    r.a,
                    [bits[*k as usize], bits[*k as usize], NULL_BITS, NULL_BITS]
                );
                assert_eq!(r.b, [NULL_BITS; 4]);
                dots.push(*k);
            }
        }
    }
    segments.sort_unstable();
    let want: Vec<u32> = (0..n - 1)
        .filter(|k| bits[*k as usize] != NULL_BITS && bits[*k as usize + 1] != NULL_BITS)
        .collect();
    assert_eq!(segments.len(), 31);
    assert_eq!(segments, want);
    assert_eq!(dots, vec![20]);
}
