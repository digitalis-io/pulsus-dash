//! Helpers shared by the dash-scene tests.
#![allow(dead_code)]

use std::sync::Arc;

use dash_scene::{Band, Camera, LineSpec, PlotCamera, Range64, Size64, Theme, Viewport, VisSpec};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};

pub const T0: f64 = 1_795_089_600_000.0;

/// One series of `values` one second apart from T0.
pub fn chunk_of(values: &[f64]) -> Chunk {
    let mut b = ChunkBuilder::explicit(ChunkId(11));
    let ts: Vec<f64> = (0..values.len()).map(|k| T0 + 1000.0 * k as f64).collect();
    let meta = SeriesMeta {
        key_hash: 0x0123_4567_89ab_cdef,
        labels: vec![("pod".into(), "a".into())],
    };
    if let Err(e) = b.push_series(meta, Some(&ts), values) {
        panic!("{e}");
    }
    b.finish()
}

pub fn viewport(chunk: Chunk, spec: LineSpec, window: Range64, band: Band) -> Viewport {
    let spec = VisSpec::Line(spec);
    Viewport {
        id: 1,
        frame_id: None,
        css: Size64 {
            w: 1118.0,
            h: 240.0,
        },
        dpr: 1.0,
        theme: Theme::Dark,
        camera: Camera::Plot2D(PlotCamera::idle(window, &spec)),
        spec,
        data: Some(Arc::new(chunk)),
        band,
    }
}
