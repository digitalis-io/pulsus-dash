//! `decimate-dump` (plan #68 C2d2 §5 `decimate_sequential`): runs the CPU decimation over a fixed,
//! seeded set of cases (the property test's shapes, overflow spans, NaN gaps, extreme and far
//! values) and writes every output field to stdout, each `f32` and `f64` as its bits. The xtask
//! test `decimate_twin` builds it twice, without features (sequential) and with `parallel`
//! (rayon), and requires the two dumps to be byte-equal.
#[path = "../tests/common/mod.rs"]
mod common;

use std::io::Write;

use common::{Prepared, encoding_for, explicit, prepare};
use dash_scales::decimate::{DecimateInput, Decimated, FarClip, decimate};
use dash_scales::encode::Encoding;
use dash_wire::Chunk;

/// SplitMix64: a fixed sequence for every build.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// In [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
}

type Series = Vec<(Vec<f64>, Vec<f64>)>;

/// The property test's shape: up to 8 series, up to 5 000 samples, a NaN share up to 0.8.
fn random(r: &mut Rng) -> Series {
    let s = 1 + r.below(8) as usize;
    let len = r.below(5001) as usize;
    let nan = r.unit() * 0.8;
    (0..s)
        .map(|_| {
            let mut t = 1.0e12;
            let mut ts = Vec::with_capacity(len);
            let mut vs = Vec::with_capacity(len);
            for _ in 0..len {
                t += (1 + r.below(40)) as f64;
                ts.push(t);
                vs.push(if r.unit() < nan {
                    f64::NAN
                } else {
                    r.unit() * 2.0e3 - 1.0e3
                });
            }
            (ts, vs)
        })
        .collect()
}

/// Many runs per column: every other sample a gap, so narrow plots overflow the inline runs.
fn overflow(r: &mut Rng) -> Series {
    (0..3)
        .map(|k| {
            let ts: Vec<f64> = (0..4000).map(|i| 1.0e12 + f64::from(i) * 10.0).collect();
            let vs = (0..4000)
                .map(|i| {
                    if (i + k) % 2 == 0 || r.below(7) == 0 {
                        f64::NAN
                    } else {
                        r.unit() * 100.0
                    }
                })
                .collect();
            (ts, vs)
        })
        .collect()
}

/// Extreme values: ±MAX, subnormals, signed zeros, and a near-constant series.
fn extreme(r: &mut Rng) -> Series {
    let pool = [
        f64::MAX,
        -f64::MAX,
        1.0e300,
        -1.0e300,
        5.0e-324,
        -5.0e-324,
        0.0,
        -0.0,
        1.0e15 + 0.5,
        1.0e15,
        f64::NAN,
    ];
    (0..4)
        .map(|k| {
            let ts: Vec<f64> = (0..1500).map(|i| 1.0e12 + f64::from(i) * 7.0).collect();
            let vs = (0..1500)
                .map(|i| {
                    if k == 3 {
                        1.0e15 + f64::from(i % 3) * 0.125
                    } else {
                        pool[r.below(pool.len() as u64) as usize]
                    }
                })
                .collect();
            (ts, vs)
        })
        .collect()
}

fn put_cols(out: &mut Vec<u8>, d: &Decimated) {
    out.extend_from_slice(&(d.cols.len() as u64).to_le_bytes());
    out.extend_from_slice(bytemuck::cast_slice(&d.cols));
    out.extend_from_slice(&(d.counts.len() as u64).to_le_bytes());
    for c in &d.counts {
        out.extend_from_slice(&c.to_le_bytes());
    }
    out.extend_from_slice(&(d.starts.len() as u64).to_le_bytes());
    for s in &d.starts {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out.extend_from_slice(&d.total.to_le_bytes());
    out.extend_from_slice(&(d.instances.len() as u64).to_le_bytes());
    out.extend_from_slice(bytemuck::cast_slice(&d.instances));
}

fn run(
    chunk: &Chunk,
    p: &Prepared,
    far: Option<FarClip<'_>>,
    window: std::ops::Range<u64>,
) -> Decimated {
    decimate(&DecimateInput {
        values_bits: &p.bits,
        offsets: &chunk.offsets,
        ranges: &p.ranges,
        n: p.n,
        guides: 0,
        colour_slots: &p.slots,
        lanes: &p.lanes,
        window,
        far,
    })
}

fn main() {
    let mut r = Rng(0x0068_C2D2);
    let mut out = Vec::new();
    let mut cases: Vec<Series> = (0..40).map(|_| random(&mut r)).collect();
    cases.extend((0..4).map(|_| overflow(&mut r)));
    cases.extend((0..4).map(|_| extreme(&mut r)));
    for (i, series) in cases.iter().enumerate() {
        let chunk = explicit(series);
        let enc = encoding_for(&chunk);
        let span = 40.0 * 5000.0;
        let (a, b) = (r.unit(), r.unit());
        let (from, to) = (1.0e12 + a.min(b) * span, 1.0e12 + a.max(b) * span + 1.0);
        let width = 1 + r.below(if i >= 40 { 40 } else { 2000 }) as u32;
        let p = prepare(&chunk, &enc, from, to, width);
        out.extend_from_slice(&(i as u64).to_le_bytes());
        put_cols(&mut out, &run(&chunk, &p, None, 0..u64::MAX));
        // A batch window of the instance list.
        put_cols(&mut out, &run(&chunk, &p, None, 3..250));
        // Far: a narrow encoding with the data beyond it, segments clipped in f64.
        let narrow = Encoding::of((-1.0, 1.0).into()).unwrap_or(enc);
        let pn = prepare(&chunk, &narrow, from, to, width);
        let far = FarClip {
            values: &chunk.values,
            clip: narrow.clip_box(),
        };
        put_cols(&mut out, &run(&chunk, &pn, Some(far), 0..u64::MAX));
        for v in &chunk.values {
            out.extend_from_slice(&v.to_bits().to_le_bytes());
        }
    }
    let mut stdout = std::io::stdout().lock();
    if let Err(e) = stdout.write_all(&out).and_then(|()| stdout.flush()) {
        eprintln!("decimate-dump: {e}");
        std::process::exit(1);
    }
}
