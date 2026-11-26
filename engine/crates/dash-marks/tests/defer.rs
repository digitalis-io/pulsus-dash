//! unit:renderer-defer (plan #68 C1 §3.1, §5; T02-029, T03-003, T03-025, ADR-0019): the
//! browser's non-blocking mode. A T1 frame whose total is not known yet draws within the current
//! capacity and reads the status header back without waiting; `poll` then reports `Complete`,
//! `Rerun` (the frame was under-sized) or, after three failed read-backs in a row, `Failed`.
mod common;

use std::sync::Arc;

use common::*;
use dash_gpu::{GpuContext, HeadlessTarget, Tier};
use dash_marks::DrawList;
use dash_marks::DrawnEvent;
use dash_marks::line::{Pending, Renderer, RendererOptions, Sync};
use dash_scene::{Band, Camera, PlotCamera, Range64, Size64, Theme, Viewport, VisSpec, build};
use pulsus_synth::{GALLERY_WINDOW, GalleryLine, gallery_line};

fn list(line: GalleryLine) -> DrawList {
    let (chunk, spec) = gallery_line(line, GALLERY_WINDOW);
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
    build(&v).0
}

fn renderer(ctx: &GpuContext, sync: Sync, max_instances: Option<u64>) -> Renderer {
    Renderer::new(
        ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions {
            max_instances,
            sync,
        },
    )
}

fn target(ctx: &GpuContext, list: &DrawList) -> HeadlessTarget {
    let (w, h) = device_size(list.css, list.dpr);
    HeadlessTarget::new(ctx, w, h)
}

/// Lets the device run the submitted work and fire map callbacks, without `GpuContext::wait`
/// (which the tests make fail).
fn settle(ctx: &GpuContext) {
    assert!(ctx.device.poll(wgpu::PollType::wait_indefinitely()).is_ok());
}

const DRAWN: DrawnEvent = DrawnEvent {
    css_width: 1118.0,
    css_height: 240.0,
    dpr: 1.0,
};

#[test]
fn defer_complete_matches_block() {
    let ctx = ctx(Tier::T1);
    let l = list(GalleryLine::Line50);
    let mut block = renderer(&ctx, Sync::Block, None);
    let (want, ev) = render(&ctx, &mut block, &l);
    assert_eq!(ev, Some(DRAWN));
    assert_eq!(block.poll(), Pending::Idle);
    let total = block.last_total();
    assert!(total.is_some_and(|t| t > 0), "{total:?}");

    let mut r = renderer(&ctx, Sync::Defer, None);
    let mut t = target(&ctx, &l);
    assert_eq!(
        r.render(&ctx, &l, &mut t),
        None,
        "the total is not known yet"
    );
    settle(&ctx);
    assert_eq!(r.poll(), Pending::Complete(DRAWN));
    assert_eq!(r.poll(), Pending::Idle);
    assert_eq!(r.last_total(), total);
    assert!(
        t.read(&ctx) == want,
        "the deferred frame differs from the blocking one"
    );
    // The total is known now: the next render of the same item is complete at once.
    let mut t2 = target(&ctx, &l);
    assert_eq!(r.render(&ctx, &l, &mut t2), Some(DRAWN));
    assert_eq!(r.poll(), Pending::Idle);
}

#[test]
fn defer_rerun_over_capacity() {
    let max = Some(4096);
    let l = list(GalleryLine::Line600);
    // T1: under-sized first, then batched past `max_instances` with no wait.
    let ctx1 = ctx(Tier::T1);
    let mut block = renderer(&ctx1, Sync::Block, max);
    let (want, _) = render(&ctx1, &mut block, &l);
    let total = block.last_total();
    assert!(total.is_some_and(|t| t > 4096), "{total:?}");
    let mut r = renderer(&ctx1, Sync::Defer, max);
    let mut t = target(&ctx1, &l);
    ctx1.fail_waits_after(0);
    assert_eq!(r.render(&ctx1, &l, &mut t), None);
    settle(&ctx1);
    assert_eq!(r.poll(), Pending::Rerun);
    assert_eq!(r.last_total(), total);
    assert_eq!(r.render(&ctx1, &l, &mut t), Some(DRAWN));
    assert!(r.last_error().is_none(), "{:?}", r.last_error());
    assert!(r.last_draws() > 1, "batched: {}", r.last_draws());
    ctx1.fail_waits_after(u64::MAX);
    assert!(
        t.read(&ctx1) == want,
        "T1: the rerun frame differs from the blocking one"
    );

    // T2: the CPU path is complete at once, batches included.
    let ctx2 = ctx(Tier::T2);
    let mut block = renderer(&ctx2, Sync::Block, max);
    let (want, _) = render(&ctx2, &mut block, &l);
    let mut r = renderer(&ctx2, Sync::Defer, max);
    let mut t = target(&ctx2, &l);
    ctx2.fail_waits_after(0);
    assert_eq!(r.render(&ctx2, &l, &mut t), Some(DRAWN));
    assert!(r.last_error().is_none(), "{:?}", r.last_error());
    assert_eq!(r.poll(), Pending::Idle);
    ctx2.fail_waits_after(u64::MAX);
    assert!(
        t.read(&ctx2) == want,
        "T2: the deferred frame differs from the blocking one"
    );
}

#[test]
fn defer_readback_failure_bounded() {
    let ctx = ctx(Tier::T1);
    let l = list(GalleryLine::Line50);
    let mut r = renderer(&ctx, Sync::Defer, None);
    ctx.fail_maps_after(0);
    let mut seen = Vec::new();
    for _ in 0..3 {
        let mut t = target(&ctx, &l);
        assert_eq!(r.render(&ctx, &l, &mut t), None);
        settle(&ctx);
        seen.push(r.poll());
    }
    seen.push(r.poll());
    assert_eq!(
        seen,
        [
            Pending::Rerun,
            Pending::Rerun,
            Pending::Failed,
            Pending::Idle
        ]
    );
}
