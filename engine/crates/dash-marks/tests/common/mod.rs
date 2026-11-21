//! Helpers shared by the dash-marks GPU tests (lavapipe, plan #68 §5).
#![allow(dead_code)]

use std::sync::Arc;

use dash_gpu::{AdapterChoice, GpuContext, HeadlessTarget, Tier};
use dash_marks::desc::{DrawList, DrawnEvent, MarkItem};
use dash_marks::line::Renderer;
use dash_scales::Range64;
use dash_scales::encode::{axis_map, choose_encoding, is_far};
use dash_scene::{Camera, PlotCamera, Size64, Viewport, YRange};
use dash_tokens::Rgba8;
use dash_wire::Chunk;

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

pub const WHITE: Rgba8 = Rgba8([255, 255, 255, 255]);
pub const BLACK: Rgba8 = Rgba8([0, 0, 0, 255]);

pub fn device_size(css: (f64, f64), dpr: f32) -> (u32, u32) {
    (
        (css.0 * f64::from(dpr)).round() as u32,
        (css.1 * f64::from(dpr)).round() as u32,
    )
}

pub fn render(
    ctx: &GpuContext,
    r: &mut Renderer,
    list: &DrawList,
) -> (Vec<u8>, Option<DrawnEvent>) {
    let (w, h) = device_size(list.css, list.dpr);
    let mut t = HeadlessTarget::new(ctx, w, h);
    let ev = r.render(ctx, list, &mut t);
    (t.read(ctx), ev)
}

pub fn reduce(m: glam::DMat4) -> [[f32; 4]; 4] {
    m.to_cols_array_2d().map(|c| c.map(|x| x as f32))
}

/// A line-only draw list, white on black, as `build` would make it for this plot and axis.
#[allow(clippy::too_many_arguments)]
pub fn line_list(
    chunk: Arc<Chunk>,
    css: (f64, f64),
    dpr: f32,
    plot: [f64; 4],
    window: (f64, f64),
    axis: Range64,
    clip: bool,
) -> DrawList {
    let enc = choose_encoding(
        chunk.finite.map(Range64::from),
        axis,
        plot[3] * f64::from(dpr),
    );
    let mut items = Vec::new();
    if let Some(enc) = enc {
        let m = axis_map(&enc, axis, plot[3]);
        let s = chunk.series.len() as u32;
        items.push(MarkItem::Line {
            far: is_far(&enc, chunk.finite),
            series: 0..s,
            window,
            n: plot[2].floor() as u32,
            plot: plot.map(|x| x as f32),
            encoding: enc,
            axis: (m.ku as f32, m.ou as f32),
            colour_slots: (0..s).map(|k| (k % 8) as u8).collect(),
            lanes: None,
            width_css: 1.5,
            chunk,
        });
    }
    let cam = Camera::Plot2D(PlotCamera {
        x: Range64::from(window),
        y: YRange::Manual(axis),
    });
    DrawList {
        clear: BLACK,
        css,
        dpr,
        view_proj: reduce(cam.view_proj(Size64 { w: css.0, h: css.1 })),
        palette: [WHITE; 9],
        clip: clip.then(|| plot.map(|x| x as f32)),
        items,
    }
}

/// `build` of a viewport, recoloured white on black.
pub fn built_white(v: &Viewport) -> DrawList {
    let (mut list, _) = dash_scene::build(v);
    list.palette = [WHITE; 9];
    list.clear = BLACK;
    list
}

pub fn covered(img: &[u8], w: u32, x: u32, y: u32) -> bool {
    img[((y * w + x) * 4) as usize] > 0
}
