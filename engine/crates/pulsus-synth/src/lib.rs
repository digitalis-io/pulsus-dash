//! Seeded synthetic data, bit-compatible with the client gallery's `dev/synth.ts` and
//! `dev/gallery.ts` (plan #68 A.6): the same seed and window always give the same data.

use dash_scene::LineSpec;
use dash_units::Unit;
use dash_wire::{Chunk, ChunkBuilder, ChunkId};

pub const GALLERY_SEED: u32 = 20_261_120;
/// 2026-11-19 12:00–13:00 UTC, the gallery's e2e window.
pub const GALLERY_WINDOW: (f64, f64) = (1_795_089_600_000.0, 1_795_093_200_000.0);

/// A hash of the integers in [0, 1); each through ECMAScript ToInt32, as `synth.ts`.
pub fn hash01(ints: &[i64]) -> f64 {
    let _ = ints;
    0.0
}

/// The value of line series `j` at `t_ms`.
pub fn synth_line_value(seed: u32, j: u32, t_ms: f64, base: f64, amp: f64) -> f64 {
    let _ = (seed, j, t_ms, base, amp);
    0.0
}

/// FNV-1a 64 over the canonical label text (`dev/keyHash.ts`).
pub fn key_hash(labels: &[(String, String)]) -> u64 {
    let _ = labels;
    0
}

/// The gallery's line entries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GalleryLine {
    Line1,
    Line50,
    LineGaps,
    Line600,
}

impl GalleryLine {
    pub const ALL: [GalleryLine; 4] = [Self::Line1, Self::Line50, Self::LineGaps, Self::Line600];

    pub fn id(self) -> &'static str {
        match self {
            Self::Line1 => "line-1",
            Self::Line50 => "line-50",
            Self::LineGaps => "line-gaps",
            Self::Line600 => "line-600",
        }
    }
}

/// A `galleryEntries` line entry as a chunk and its spec.
pub fn gallery_line(which: GalleryLine, window: (f64, f64)) -> (Chunk, LineSpec) {
    let _ = (which, window);
    (ChunkBuilder::explicit(ChunkId(0)).finish(), LineSpec::new(Unit::None))
}

pub mod reference;
