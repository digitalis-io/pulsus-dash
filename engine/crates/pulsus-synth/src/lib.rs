//! Seeded synthetic data, bit-compatible with the client gallery's `dev/synth.ts` and
//! `dev/gallery.ts` (plan #68 A.6): the same seed and window always give the same data.

use dash_scene::LineSpec;
use dash_units::{TimeBase, Unit};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};

pub const GALLERY_SEED: u32 = 20_261_120;
/// 2026-11-19 12:00–13:00 UTC, the gallery's e2e window.
pub const GALLERY_WINDOW: (f64, f64) = (1_795_089_600_000.0, 1_795_093_200_000.0);

/// A hash of the integers in [0, 1); each through ECMAScript ToInt32, as `synth.ts`.
pub fn hash01(ints: &[i64]) -> f64 {
    let mut h: u32 = 0x9e37_79b9;
    for n in ints {
        // ECMAScript ToInt32 (`n | 0`): the value modulo 2^32.
        let n32 = *n as i32 as u32;
        h = (h ^ n32).wrapping_mul(0x85eb_ca6b);
        h ^= h >> 13;
        h = h.wrapping_mul(0xc2b2_ae35);
        h ^= h >> 16;
    }
    f64::from(h) / 4_294_967_296.0
}

/// The value of line series `j` at `t_ms`.
pub fn synth_line_value(seed: u32, j: u32, t_ms: f64, base: f64, amp: f64) -> f64 {
    let (seed, j) = (i64::from(seed), i64::from(j));
    let b = base * (0.5 + hash01(&[seed, j, 1]));
    let a = amp * (0.5 + hash01(&[seed, j, 2]));
    let period = 600_000.0 * (1.0 + (6.0 * hash01(&[seed, j, 3])).floor());
    let phase = 2.0 * std::f64::consts::PI * hash01(&[seed, j, 4]);
    let noise = 0.2 * a * (hash01(&[seed, j, 5, (t_ms / 1000.0).floor() as i64]) - 0.5);
    b + a * ((2.0 * std::f64::consts::PI * t_ms) / period + phase).sin() + noise
}

/// `synth.ts` `isGap`: the gaps of the `line-gaps` entry.
fn is_gap(j: u32, k: u32) -> bool {
    match j {
        0 => (300..360).contains(&k),
        1 => k % 97 == 13,
        2 => (500..520).contains(&k) && k != 510,
        _ => false,
    }
}

/// FNV-1a 64 over the canonical label text (`dev/keyHash.ts`).
pub fn key_hash(labels: &[(String, String)]) -> u64 {
    let mut sorted: Vec<&(String, String)> = labels.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let text: Vec<String> = sorted.iter().map(|(k, v)| format!("{k}=\"{v}\"")).collect();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in text.join(",").bytes() {
        h ^= u64::from(byte);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// The gallery's line entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GalleryLine {
    Line1,
    Line50,
    LineGaps,
    Line600,
    /// `line-extreme`: one series mapped onto [−f64::MAX, f64::MAX] (gallery.ts `nearLimit`).
    LineExtreme,
}

impl GalleryLine {
    /// The pages of the native goldens and parity fixtures (plan #68 Part A).
    pub const ALL: [GalleryLine; 4] = [Self::Line1, Self::Line50, Self::LineGaps, Self::Line600];
    /// Every line page `dash-golden render` draws (`golden:engine-line`, plan #68 C1).
    pub const RENDERABLE: [GalleryLine; 5] = [
        Self::Line1,
        Self::Line50,
        Self::LineGaps,
        Self::Line600,
        Self::LineExtreme,
    ];

    pub fn id(self) -> &'static str {
        match self {
            Self::Line1 => "line-1",
            Self::Line50 => "line-50",
            Self::LineGaps => "line-gaps",
            Self::Line600 => "line-600",
            Self::LineExtreme => "line-extreme",
        }
    }
}

/// A `galleryEntries` line entry as a chunk and its spec.
/// `synthLines` of one entry: (index, series, points, name, base, amp, gaps, unit).
fn entry(which: GalleryLine) -> (u32, u32, u32, &'static str, f64, f64, bool, Unit) {
    match which {
        GalleryLine::Line1 => (
            0,
            1,
            1440,
            "http_requests_per_second",
            1200.0,
            300.0,
            false,
            Unit::Suffix {
                suffix: "rps".into(),
            },
        ),
        GalleryLine::Line50 => (
            1,
            50,
            1440,
            "http_request_duration_ms",
            180.0,
            40.0,
            false,
            Unit::Time { base: TimeBase::Ms },
        ),
        GalleryLine::LineGaps => (2, 3, 1440, "queue_depth", 40.0, 15.0, true, Unit::None),
        GalleryLine::Line600 => (
            3,
            600,
            60,
            "container_memory_bytes",
            8e8,
            2e8,
            false,
            Unit::bytes(),
        ),
        GalleryLine::LineExtreme => (9, 1, 1440, "near_limit_values", 0.0, 1.0, false, Unit::None),
    }
}

/// gallery.ts `nearLimit`: a series' finite values mapped onto [−MAX, MAX] by
/// q = (v − lo)/(hi − lo), MAX·(2q − 1); NaN stays; hi = lo → 0. The same IEEE operations as TS.
fn near_limit(values: &mut [f64]) {
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for v in values.iter().filter(|v| v.is_finite()) {
        lo = lo.min(*v);
        hi = hi.max(*v);
    }
    for v in values.iter_mut().filter(|v| v.is_finite()) {
        *v = if hi == lo {
            0.0
        } else {
            let q = (*v - lo) / (hi - lo);
            f64::MAX * (2.0 * q - 1.0)
        };
    }
}

/// The `galleryEntries` line entry (seed GALLERY_SEED + index) as a grid chunk and its spec;
/// key_hash from FNV-1a 64 over the canonical labels (`dev/keyHash.ts`).
pub fn gallery_line(which: GalleryLine, window: (f64, f64)) -> (Chunk, LineSpec) {
    let (i, series, points, name, base, amp, gaps, unit) = entry(which);
    let seed = GALLERY_SEED + i;
    let step = ((window.1 - window.0) / f64::from(points)).floor();
    let mut b = ChunkBuilder::grid(
        ChunkId(u64::from(seed)),
        window.0 as i64,
        step as i64,
        points,
    );
    for j in 0..series {
        let labels = vec![
            ("__name__".to_owned(), name.to_owned()),
            ("pod".to_owned(), format!("pod-{j:03}")),
        ];
        let mut values: Vec<f64> = (0..points)
            .map(|k| {
                let t = window.0 + f64::from(k) * step;
                if gaps && is_gap(j, k) {
                    f64::NAN
                } else {
                    synth_line_value(seed, j, t, base, amp)
                }
            })
            .collect();
        if which == GalleryLine::LineExtreme {
            near_limit(&mut values);
        }
        let meta = SeriesMeta {
            key_hash: key_hash(&labels),
            labels: labels.into(),
        };
        // Grid series of exactly `points` values always fit.
        if b.push_series(meta, None, &values).is_err() {
            break;
        }
    }
    (b.finish(), LineSpec::new(unit))
}

pub mod reference;
