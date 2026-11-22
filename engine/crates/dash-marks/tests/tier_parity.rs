//! unit:decimation-tier-parity (plan #68 §5, T02-029): the T1 compute passes and the CPU path give
//! byte-equal `ColOut`, counts, starts, total and instances.
mod common;

use std::sync::Arc;

use common::*;
use dash_gpu::Tier;
use dash_marks::MarkItem;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scales::Range64;
use dash_scales::column_ranges;
use dash_scales::decimate::{DecimateInput, decimate};
use dash_wire::{Chunk, ChunkBuilder, ChunkId, SeriesMeta};
use pulsus_synth::hash01;

fn data(seed: u32) -> Chunk {
    let (series, len) = (64usize, 10_000u32);
    let explicit = seed % 2 == 1;
    let mut b = if explicit {
        ChunkBuilder::explicit(ChunkId(u64::from(seed)))
    } else {
        ChunkBuilder::grid(ChunkId(u64::from(seed)), 0, 100, len)
    };
    for s in 0..series {
        let nan = 0.15 + 0.5 * hash01(&[i64::from(seed), s as i64]);
        let vs: Vec<f64> = (0..len)
            .map(|k| {
                let h = hash01(&[i64::from(seed), s as i64, i64::from(k)]);
                if h < nan {
                    f64::NAN
                } else {
                    (h - 0.5) * 1e3 + s as f64
                }
            })
            .collect();
        let ts: Vec<f64> = (0..len)
            .map(|k| f64::from(k) * 100.0 + 50.0 * hash01(&[7, i64::from(k)]))
            .collect();
        let meta = SeriesMeta {
            key_hash: s as u64,
            labels: Vec::new(),
        };
        ok(
            b.push_series(meta, explicit.then_some(&ts[..]), &vs),
            "series",
        );
    }
    b.finish()
}

#[test]
fn compute_equals_cpu() {
    let ctx = ctx(Tier::T1);
    let mut r = Renderer::new(
        &ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions::default(),
    );
    let mut overflow_columns = 0;
    for seed in 0..20u32 {
        let chunk = Arc::new(data(seed));
        let width = 300 + (seed * 89) % 1701;
        let plot = [40.0, 8.0, f64::from(width), 400.0];
        let window = (0.0, 1_000_000.0);
        let (lo, hi) = chunk.finite.unwrap_or((0.0, 1.0));
        let list = line_list(
            chunk.clone(),
            (f64::from(width) + 48.0, 440.0),
            1.0,
            plot,
            window,
            Range64 { lo, hi },
            false,
        );
        let Some(MarkItem::Line {
            encoding,
            colour_slots,
            n,
            far,
            ..
        }) = list.items.first()
        else {
            panic!("seed {seed}: no line item");
        };
        assert!(!far);
        let _ = render(&ctx, &mut r, &list);
        let Some(gpu) = r.read_decimation(&ctx) else {
            panic!("seed {seed}: no read back")
        };
        let bits: Vec<u32> = chunk.values.iter().map(|v| encoding.encode(*v)).collect();
        let ranges = column_ranges(&chunk, 0..64, window.0, window.1, *n);
        let lanes = vec![0u16; 64];
        let cpu = decimate(&DecimateInput {
            values_bits: &bits,
            offsets: &chunk.offsets,
            ranges: &ranges,
            n: *n,
            guides: 0,
            colour_slots,
            lanes: &lanes,
            window: 0..u64::MAX,
            far: None,
        });
        overflow_columns += cpu.cols.iter().filter(|c| c.n_runs >= 5).count();
        assert_eq!(
            bytemuck::cast_slice::<_, u8>(&gpu.cols),
            bytemuck::cast_slice::<_, u8>(&cpu.cols),
            "seed {seed}: cols"
        );
        assert_eq!(gpu.counts, cpu.counts, "seed {seed}: counts");
        assert_eq!(gpu.starts, cpu.starts, "seed {seed}: starts");
        assert_eq!(gpu.total, cpu.total, "seed {seed}: total");
        assert_eq!(
            bytemuck::cast_slice::<_, u8>(&gpu.instances),
            bytemuck::cast_slice::<_, u8>(&cpu.instances),
            "seed {seed}: instances"
        );
    }
    assert!(overflow_columns > 0, "no column with ≥ 5 runs");
}
