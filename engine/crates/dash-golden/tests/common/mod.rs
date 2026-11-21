//! Helpers shared by the golden tests.
#![allow(dead_code)]

use std::sync::Arc;

use dash_golden::{Image, RefFrame, line_list, render_list};
use dash_gpu::{AdapterChoice, GpuContext, Tier};
use dash_marks::desc::DrawList;
use dash_marks::line::{Renderer, RendererOptions};
use dash_scales::Range64;
use pulsus_synth::reference::{RefFixture, WINDOW};

pub const PLOT: [f64; 4] = [40.0, 8.0, 1000.0, 400.0];
pub const CSS: (f64, f64) = (1048.0, 416.0);

pub fn ok<T, E: std::fmt::Debug>(r: Result<T, E>, what: &str) -> T {
    match r {
        Ok(v) => v,
        Err(e) => panic!("{what}: {e:?}"),
    }
}

pub fn ctx(tier: Tier) -> GpuContext {
    let c = GpuContext::headless(AdapterChoice::Lavapipe, tier);
    assert!(c.is_ok(), "no lavapipe adapter: {:?}", c.as_ref().err());
    ok(c, "lavapipe")
}

/// The auto axis of a reference fixture: its data range widened by 5 % each side.
pub fn axis_of(fx: &RefFixture) -> Range64 {
    if let Some(m) = fx.manual {
        return m;
    }
    let (lo, hi) = fx.chunk.finite.unwrap_or((0.0, 1.0));
    let pad = (hi - lo).max(1.0) * 0.05;
    Range64 {
        lo: lo - pad,
        hi: hi + pad,
    }
}

pub fn list_of(fx: &RefFixture, dpr: f32) -> DrawList {
    line_list(
        Arc::new(fx.chunk.clone()),
        CSS,
        dpr,
        PLOT,
        WINDOW,
        axis_of(fx),
        fx.manual.is_some(),
    )
}

pub fn frame_of(fx: &RefFixture, dpr: f32) -> RefFrame {
    let size = dash_golden::device_size(CSS, dpr);
    RefFrame {
        plot: PLOT,
        window: WINDOW,
        axis: axis_of(fx),
        dpr: f64::from(dpr),
        width_css: 1.5,
        size,
    }
}

pub fn render(ctx: &GpuContext, list: &DrawList) -> Image {
    let mut r = Renderer::new(
        ctx,
        wgpu::TextureFormat::Rgba8Unorm,
        RendererOptions::default(),
    );
    render_list(ctx, &mut r, list)
}
