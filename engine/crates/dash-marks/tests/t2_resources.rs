//! unit:t2-resources (plan #68 C1 §3.1, §5; VIZ-001): on T2 (WebGL2, no compute) the renderer
//! creates no compute pipeline and no storage or indirect buffer, and still draws; on T1 it has
//! both. `max_instances` follows the tier.
mod common;

use std::sync::Arc;

use common::*;
use dash_gpu::Tier;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scene::{Band, Camera, PlotCamera, Range64, Size64, Theme, Viewport, VisSpec, build};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};

#[test]
fn t2_has_no_compute_resources() {
    let (chunk, spec) = gallery_line(GalleryLine::Line50, GALLERY_WINDOW);
    let spec = VisSpec::Line(spec);
    let v = Viewport {
        id: 0,
        frame_id: None,
        css: Size64 {
            w: 1118.0,
            h: 240.0,
        },
        dpr: 1.0,
        theme: Theme::Dark,
        camera: Camera::Plot2D(PlotCamera::idle(Range64::from(GALLERY_WINDOW), &spec)),
        spec,
        data: Some(Arc::new(chunk)),
        band: Band::Measure,
        events: std::sync::Arc::from([]),
        selection: Default::default(),
    };
    let l = build(&v).0;
    for tier in [Tier::T2, Tier::T1] {
        let ctx = ctx(tier);
        let limits = ctx.device.limits();
        let mut r = Renderer::new(
            &ctx,
            wgpu::TextureFormat::Rgba8Unorm,
            RendererOptions::default(),
        );
        let (_, ev) = render(&ctx, &mut r, &l);
        assert!(ev.is_some(), "{tier:?}: not drawn");
        let c = r.debug_counters();
        match tier {
            Tier::T2 => {
                assert_eq!((c.compute_pipelines, c.storage_buffers), (0, 0));
                assert_eq!(ctx.max_instances, limits.max_buffer_size / 16);
            }
            Tier::T1 => {
                assert!(c.compute_pipelines > 0 && c.storage_buffers > 0, "{c:?}");
                assert_eq!(
                    ctx.max_instances,
                    limits
                        .max_buffer_size
                        .min(limits.max_storage_buffer_binding_size)
                        / 16
                );
            }
        }
    }
}
