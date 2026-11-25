//! unit:spike-visible (plan #68 §5, VIZ-005): one sample of 10⁶ is drawn at its value.
mod common;

use std::sync::Arc;

use common::*;
use dash_gpu::Tier;
use dash_marks::MarkItem;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scales::Range64;
use dash_scales::encode::Encoding;
use dash_wire::{ChunkBuilder, ChunkId, SeriesMeta};

#[test]
fn spike_is_drawn() {
    let len = 1_000_000u32;
    let mut b = ChunkBuilder::grid(ChunkId(5), 0, 1, len);
    let mut vs = vec![1.0; len as usize];
    vs[400_000] = 50.0;
    ok(
        b.push_series(
            SeriesMeta {
                key_hash: 3,
                labels: Vec::new().into(),
            },
            None,
            &vs,
        ),
        "series",
    );
    let chunk = Arc::new(b.finish());
    let plot = [40.0, 8.0, 1000.0, 400.0];
    let window = (0.0, f64::from(len - 1));
    let axis = Range64 { lo: 0.0, hi: 50.0 };
    let list = line_list(chunk, (1048.0, 440.0), 1.0, plot, window, axis, false);
    let Some(MarkItem::Line { encoding, .. }) = list.items.first() else {
        panic!("no line")
    };
    // The data encoding of [1, 50]: v_ref = 25.5, exp = fexp(49) = 6 (A.3).
    assert_eq!(
        *encoding,
        Encoding {
            v_ref: 25.5,
            exp: 6
        }
    );
    let col = (400_000.0 / f64::from(len - 1) * 1000.0).floor() as u32;
    for tier in [Tier::T1, Tier::T2] {
        let ctx = ctx(tier);
        let mut r = Renderer::new(
            &ctx,
            wgpu::TextureFormat::Rgba8Unorm,
            RendererOptions::default(),
        );
        let (img, _) = render(&ctx, &mut r, &list);
        let Some(d) = r.read_decimation(&ctx) else {
            panic!("{tier:?}: no decimation")
        };
        let c = d.cols[col as usize];
        assert_eq!(c.runs[0][0], 0.382_812_5f32, "{tier:?}: run max u");
        let x = 40 + col;
        let y50 = 8u32; // y(50.0) = plot.y on the axis [0, 50]
        let hit = (y50.saturating_sub(1)..=y50 + 1).any(|y| covered(&img, 1048, x, y));
        assert!(hit, "{tier:?}: no coverage at the spike");
    }
}
