//! unit:decimation-batches (plan #68 §5, §4.2, T02-002, T02-015): past `max_instances` a viewport
//! is drawn in ordered batches whose pixels equal one draw.
mod common;

use std::sync::Arc;

use common::*;
use dash_gpu::Tier;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scene::{Band, Camera, LineSpec, PlotCamera, Range64, Size64, Theme, Viewport, VisSpec};
use dash_units::Unit;
use pulsus_synth::reference::{WINDOW, f2};

#[test]
fn batched_draws_equal_one_draw() {
    let fx = ok(f2(100, 10_000), "F2");
    for tier in [Tier::T1, Tier::T2] {
        let ctx = ctx(tier);
        let spec = VisSpec::Line(LineSpec::new(Unit::None));
        let v = Viewport {
            id: 0,
            frame_id: None,
            css: Size64 { w: 1000.0, h: 400.0 },
            dpr: 1.0,
            theme: Theme::Dark,
            camera: Camera::Plot2D(PlotCamera::idle(Range64::from(WINDOW), &spec)),
            spec,
            data: Some(Arc::new(fx.chunk.clone())),
            band: Band::Measure,
        };
        let (list, _) = dash_scene::build(&v);
        let mut one = Renderer::new(&ctx, wgpu::TextureFormat::Rgba8Unorm, RendererOptions::default());
        let (a, _) = render(&ctx, &mut one, &list);
        assert_eq!(one.last_draws(), 1, "{tier:?}");
        let Some(d) = one.read_decimation(&ctx) else { panic!("{tier:?}: no decimation") };
        let g = list.items.iter().map(|i| match i {
            dash_marks::MarkItem::Guides { lines, .. } => lines.len() as u64,
            _ => 0,
        }).sum::<u64>();
        let mut batched = Renderer::new(&ctx, wgpu::TextureFormat::Rgba8Unorm, RendererOptions { max_instances: Some(1000) });
        let (b, _) = render(&ctx, &mut batched, &list);
        let want = (g + d.total).div_ceil(1000) as u32;
        assert!(want > 1, "{tier:?}: precondition, {} instances", g + d.total);
        assert_eq!(batched.last_draws(), want, "{tier:?}");
        assert!(a == b, "{tier:?}: batched image differs");
    }
}
