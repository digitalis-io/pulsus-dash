//! Helpers shared by the dash-scales tests.
#![allow(dead_code)]

use dash_scales::decimate::{DecimateInput, Decimated, LineInstance, decimate};
use dash_scales::encode::Encoding;
use dash_scales::{ColumnRanges, column_ranges};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};

pub const KIND_SEGMENT: u32 = 0;
pub const KIND_SPAN: u32 = 1;
pub const KIND_DOT: u32 = 2;

pub fn kind(i: &LineInstance) -> u32 {
    (i.meta >> 4) & 3
}

pub fn column(i: &LineInstance) -> u32 {
    i.col & 0xFFFF
}

pub fn dx(i: &LineInstance) -> u32 {
    i.col >> 16
}

pub fn explicit(series: &[(Vec<f64>, Vec<f64>)]) -> Chunk {
    let mut b = ChunkBuilder::explicit(ChunkId(7));
    for (k, (ts, vs)) in series.iter().enumerate() {
        let meta = SeriesMeta {
            key_hash: k as u64,
            labels: Vec::new(),
        };
        if let Err(e) = b.push_series(meta, Some(ts), vs) {
            panic!("series {k}: {e}");
        }
    }
    b.finish()
}

pub fn encoding_for(c: &Chunk) -> Encoding {
    c.finite
        .and_then(|r| Encoding::of(r.into()))
        .unwrap_or(Encoding {
            v_ref: c.finite.map_or(0.0, |r| r.0),
            exp: 0,
        })
}

pub struct Prepared {
    pub bits: Vec<u32>,
    pub ranges: ColumnRanges,
    pub slots: Vec<u8>,
    pub lanes: Vec<u16>,
    pub n: u32,
}

pub fn prepare(c: &Chunk, enc: &Encoding, from: f64, to: f64, n: u32) -> Prepared {
    let s = c.series.len() as u32;
    Prepared {
        bits: c.values.iter().map(|v| enc.encode(*v)).collect(),
        ranges: column_ranges(c, 0..s, from, to, n),
        slots: (0..s).map(|k| (k % 8) as u8).collect(),
        lanes: (0..s).map(|k| k as u16).collect(),
        n,
    }
}

pub fn run(c: &Chunk, p: &Prepared) -> Decimated {
    decimate(&DecimateInput {
        values_bits: &p.bits,
        offsets: &c.offsets,
        ranges: &p.ranges,
        n: p.n,
        guides: 0,
        colour_slots: &p.slots,
        lanes: &p.lanes,
        window: 0..u64::MAX,
        far: None,
    })
}
