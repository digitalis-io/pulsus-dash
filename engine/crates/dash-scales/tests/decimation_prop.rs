//! unit:decimation-prop (plan #68 §5): every span is exactly one NaN-free run, every raw sample is
//! inside its run's span, `total` counts the instances, and the result does not depend on the
//! rayon pool size (T02-015, T03-021, VIZ-006) under feature `parallel`.
mod common;

use common::*;
use proptest::prelude::*;

fn split_runs(bits: &[u32]) -> Vec<Vec<f32>> {
    let mut runs: Vec<Vec<f32>> = Vec::new();
    let mut open = false;
    for b in bits {
        if *b == dash_scales::encode::GAP_BITS {
            open = false;
        } else {
            if !open {
                runs.push(Vec::new());
                open = true;
            }
            if let Some(r) = runs.last_mut() {
                r.push(f32::from_bits(*b));
            }
        }
    }
    runs
}

fn max_min(r: &[f32]) -> [u32; 2] {
    let (mut hi, mut lo) = (r[0], r[0]);
    for v in r {
        if *v > hi {
            hi = *v;
        }
        if *v < lo {
            lo = *v;
        }
    }
    [hi.to_bits(), lo.to_bits()]
}

fn series_strategy() -> impl Strategy<Value = Vec<(Vec<f64>, Vec<f64>)>> {
    (1usize..=8, 0usize..=5000, 0.0f64..=0.8).prop_flat_map(|(s, len, nan)| {
        proptest::collection::vec(
            proptest::collection::vec((1u32..=40, -1.0e3f64..1.0e3, 0.0f64..1.0), len).prop_map(
                move |steps| {
                    let mut t = 1.0e12;
                    let mut ts = Vec::with_capacity(steps.len());
                    let mut vs = Vec::with_capacity(steps.len());
                    for (dt, v, r) in steps {
                        t += f64::from(dt);
                        ts.push(t);
                        vs.push(if r < nan { f64::NAN } else { v });
                    }
                    (ts, vs)
                },
            ),
            s,
        )
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(64))]
    #[test]
    fn spans_are_runs(series in series_strategy(), width in 1u32..=2000, a in 0.0f64..1.0, b in 0.0f64..1.0) {
        let chunk = explicit(&series);
        let span = 40.0 * 5000.0;
        let (from, to) = (1.0e12 + a.min(b) * span, 1.0e12 + a.max(b) * span + 1.0);
        let enc = encoding_for(&chunk);
        let p = prepare(&chunk, &enc, from, to, width);
        let d = run(&chunk, &p);
        prop_assert_eq!(d.cols.len(), series.len() * width as usize);
        // (3) total = Σ instances, and the instance list covers [0, total).
        prop_assert_eq!(d.total as usize, d.instances.len());
        prop_assert_eq!(d.total, d.counts.iter().map(|c| u64::from(*c)).sum::<u64>());
        for s in 0..series.len() {
            let base = chunk.offsets[s];
            for c in 0..width as usize {
                let (lo, hi) = p.ranges.range(s, c, base);
                let runs = split_runs(&p.bits[lo as usize..hi as usize]);
                let co = d.cols[s * width as usize + c];
                prop_assert_eq!(co.n_runs as usize, runs.len());
                let finite: usize = runs.iter().map(Vec::len).sum();
                if finite < 2 {
                    continue;
                }
                let got: Vec<[u32; 2]> = d.instances.iter()
                    .filter(|i| column(i) == c as u32 && kind(i) != KIND_SEGMENT
                        && (i.meta & 0xF) as usize == s % 8 && (i.meta >> 16) as usize == s)
                    .map(|i| [i.va.to_bits(), i.vb.to_bits()])
                    .collect();
                // (1) one span per run, its own [max, min].
                let want: Vec<[u32; 2]> = runs.iter().map(|r| max_min(r)).collect();
                prop_assert_eq!(&got, &want);
                // (2) every raw finite sample lies inside its run's span.
                for (r, sp) in runs.iter().zip(&got) {
                    for v in r {
                        prop_assert!(*v <= f32::from_bits(sp[0]) && *v >= f32::from_bits(sp[1]));
                    }
                }
            }
        }
        // (4) bit-identical across rayon pool sizes (`parallel`; plan #68 C2d2: without it the
        // decimation is sequential, and `decimate_sequential` compares the two builds).
        #[cfg(feature = "parallel")]
        for threads in [1, 2, 7] {
            let pool = rayon::ThreadPoolBuilder::new().num_threads(threads).build();
            prop_assert!(pool.is_ok());
            if let Ok(pool) = pool {
                let again = pool.install(|| run(&chunk, &p));
                prop_assert_eq!(&again, &d);
            }
        }
    }
}
