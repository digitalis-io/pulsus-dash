//! unit:drawn (plan #68 §5, ADR-0019 (1), (2), D-DRAWN).
mod common;

use std::sync::Arc;

use common::*;
use dash_gpu::Tier;
use dash_marks::DrawnEvent;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scene::{Band, Camera, PlotCamera, Range64, Size64, Theme, Viewport, VisSpec, build};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};

#[test]
fn drawn_only_for_complete_frames() {
    let ctx = ctx(Tier::T1);
    let (chunk, spec) = gallery_line(GalleryLine::Line50, GALLERY_WINDOW);
    let spec = VisSpec::Line(spec);
    let mut v = Viewport {
        id: 0,
        frame_id: None,
        css: Size64 {
            w: 1118.0,
            h: 240.0,
        },
        dpr: 2.0,
        theme: Theme::Dark,
        camera: Camera::Plot2D(PlotCamera::idle(Range64::from(GALLERY_WINDOW), &spec)),
        spec,
        data: Some(Arc::new(chunk)),
        band: Band::Measure,
        events: std::sync::Arc::from([]),
        selection: Default::default(),
        fit: None,
        fade: None,
    };
    let mut r = Renderer::new(
        &ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions::default(),
    );
    let (a, ev) = render(&ctx, &mut r, &build(&v).0);
    assert_eq!(
        ev,
        Some(DrawnEvent {
            css_width: 1118.0,
            css_height: 240.0,
            dpr: 2.0
        })
    );
    v.frame_id = Some("panel-7".into());
    let (b, ev2) = render(&ctx, &mut r, &build(&v).0);
    assert_eq!(ev2, ev);
    assert!(a == b, "frame_id changed the image");
    v.css = Size64 { w: 0.0, h: 240.0 };
    let (_, ev3) = render(&ctx, &mut r, &build(&v).0);
    assert_eq!(ev3, None);
}
