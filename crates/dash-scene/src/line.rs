//! The line chart scene (plan #24 §3.4): layer, series ranges, fit, camera and the per-frame
//! uniforms of the M1 line mark.

use dash_axes::minimal::{Plot, segments};
use dash_protocol::input::{InputRecord, RecordHeader};
use dash_scales::lod::{Columns, MARGIN, Prepared, XMap};
use dash_tokens::spike::{LINE, LINE_WIDTH_CSS, PLOT_INSET_CSS};

use crate::InputSink;
use crate::camera::{Camera2d, Controller, Limits};

/// The loaded layer's grid and series counts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayerInfo {
    pub start_ms: i64,
    pub step_ms: i64,
    pub n: u32,
    pub requested: u32,
    pub held: u32,
}

/// Why fewer series are drawn than requested (T02-016, VIZ-005).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoverageReason {
    Loading,
    StCeiling,
    TextureCeiling,
    LoadFailed,
}

impl CoverageReason {
    pub fn id(self) -> &'static str {
        match self {
            CoverageReason::Loading => "loading",
            CoverageReason::StCeiling => "st-ceiling",
            CoverageReason::TextureCeiling => "texture-ceiling",
            CoverageReason::LoadFailed => "load-failed",
        }
    }
}

/// Series coverage of the chart.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LineCoverage {
    pub requested: u32,
    pub held: u32,
    pub drawn: u32,
    pub reasons: Vec<CoverageReason>,
}

impl LineCoverage {
    /// Space-separated reason ids in enum order; `""` when every series is drawn.
    pub fn ids(&self) -> String {
        self.reasons
            .iter()
            .map(|r| r.id())
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// The line mark's uniform block (4 240 bytes; offsets mirrored by `line_common.wgsl`).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct LineUniforms {
    pub canvas_px: [f32; 2],
    pub plot_origin_px: [f32; 2],
    pub plot_size_px: [f32; 2],
    pub c0: f32,
    pub s: f32,
    pub a_y: f32,
    pub half_w: f32,
    pub slots: u32,
    pub margin: u32,
    pub radius: u32,
    pub series: u32,
    pub n: u32,
    pub tex_w: u32,
    pub levels: u32,
    pub k0: i32,
    pub k_l: u32,
    pub k_r: u32,
    pub colour: [f32; 4],
    pub pyr_base: [u32; 4],
    pub pyr_len: [u32; 4],
    pub tile_w: u32,
    pub k_from_c: u32,
    pub _pad: [u32; 2],
    pub series_d: [[f32; 4]; 256],
}

impl LineUniforms {
    /// Sets series `i`'s y offset (`series_d[i >> 2][i & 3]`); ignored for `i ≥ 1 024`.
    pub fn set_d(&mut self, i: u32, d: f32) {
        if let Some(v) = self
            .series_d
            .get_mut((i >> 2) as usize)
            .map(|q| &mut q[(i & 3) as usize])
        {
            *v = d;
        }
    }

    /// Series `i`'s y offset (0 for `i ≥ 1 024`).
    pub fn d(&self, i: u32) -> f32 {
        self.series_d
            .get((i >> 2) as usize)
            .map_or(0.0, |q| q[(i & 3) as usize])
    }
}

/// The value and pyramid texture layout the frame's uniforms carry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayoutInfo {
    pub tex_w: u32,
    pub levels: u32,
    pub pyr_base: [u32; 4],
    pub pyr_len: [u32; 4],
}

/// One frame of the line chart.
#[derive(Clone, Debug, PartialEq)]
pub struct LineFrame {
    pub uniforms: Box<LineUniforms>,
    pub columns: Columns,
    pub plot: Plot,
    /// Gridlines, axis lines and ticks (device px, y up).
    pub grid: Vec<[f32; 4]>,
}

/// Rounded device px of a CSS length.
fn dev(css: f32, dpr: f32) -> f32 {
    (css * dpr).round()
}

/// The canvas size in device px.
fn canvas_px(css_w: f32, css_h: f32, dpr: f32) -> [f32; 2] {
    [dev(css_w, dpr), dev(css_h, dpr)]
}

/// The plot rectangle of a canvas: `PLOT_INSET_CSS` `[l, r, t, b]` in rounded device px.
pub fn plot_rect(css_w: f32, css_h: f32, dpr: f32) -> Plot {
    let [l, r, t, b] = PLOT_INSET_CSS.map(|v| dev(v, dpr));
    let [w, h] = canvas_px(css_w, css_h, dpr);
    Plot {
        x0: l,
        y0: b,
        w: (w - l - r).max(1.0) as u32,
        h: (h - t - b).max(1.0) as u32,
    }
}

/// The line chart scene.
#[derive(Debug)]
pub struct LineScene {
    controller: Controller,
    layer: Option<LayerInfo>,
    series: Vec<Prepared>,
    /// CSS width, height and DPR.
    canvas: Option<(f32, f32, f32)>,
    ceiling: Option<u32>,
    load_failed: bool,
}

impl Default for LineScene {
    fn default() -> Self {
        Self::new()
    }
}

impl LineScene {
    pub fn new() -> Self {
        let c = Camera2d {
            t_left_rel_ms: 0.0,
            ms_per_px: 1.0,
            v_bottom: -1.0,
            v_per_px: 1.0,
        };
        let l = Limits {
            min_ms_per_px: 1.0,
            max_ms_per_px: 1.0,
            min_v_per_px: 1.0,
            max_v_per_px: 1.0,
            t_range: (0.0, 0.0),
            v_range: (-1.0, 1.0),
        };
        LineScene {
            controller: Controller::new(c, l),
            layer: None,
            series: Vec::new(),
            canvas: None,
            ceiling: None,
            load_failed: false,
        }
    }

    fn plot(&self) -> Option<(Plot, f32)> {
        self.canvas.map(|(w, h, dpr)| (plot_rect(w, h, dpr), dpr))
    }

    /// The finite value range of the series added so far.
    fn range(&self) -> Option<(f64, f64)> {
        self.series
            .iter()
            .filter(|p| p.min.is_finite() && p.max.is_finite())
            .fold(None, |acc, p| match acc {
                None => Some((p.min, p.max)),
                Some((lo, hi)) => Some((lo.min(p.min), hi.max(p.max))),
            })
    }

    /// Recomputes the limits and, until the user moved, the fit (§3.4).
    fn refit(&mut self) {
        let (Some(layer), Some((plot, _))) = (self.layer, self.plot()) else {
            return;
        };
        let (w, h) = (f64::from(plot.w), f64::from(plot.h));
        let step = layer.step_ms as f64;
        let e = f64::from(layer.n) * step;
        let (min, max) = self.range().unwrap_or((-1.0, 1.0));
        let r = (max - min).max(1e-12);
        let limits = Limits {
            min_ms_per_px: step / 16.0,
            max_ms_per_px: 4.0 * e / w,
            min_v_per_px: r * 1e-3 / h,
            max_v_per_px: r * 100.0 / h,
            t_range: (0.0, e),
            v_range: (min, max),
        };
        let camera = if self.controller.user_moved() {
            *self.controller.camera()
        } else {
            let (lo, hi) = if max - min > 0.0 {
                (min - 0.05 * (max - min), max + 0.05 * (max - min))
            } else {
                (min - 1.0, max + 1.0)
            };
            Camera2d {
                t_left_rel_ms: 0.0,
                ms_per_px: e / w,
                v_bottom: lo,
                v_per_px: (hi - lo) / h,
            }
        };
        self.controller.set_camera(camera, limits);
    }

    pub fn set_canvas(&mut self, css_w: f32, css_h: f32, dpr: f32) {
        if css_w > 0.0 && css_h > 0.0 && dpr > 0.0 {
            self.canvas = Some((css_w, css_h, dpr));
            self.refit();
        }
    }

    /// A new layer: the series start again.
    pub fn set_layer(&mut self, l: LayerInfo) {
        self.layer = Some(l);
        self.series.clear();
        self.refit();
    }

    /// Adds the next series (in id order).
    pub fn add_series(&mut self, p: Prepared) {
        self.series.push(p);
        self.refit();
    }

    /// Only `max_series` series fit the GPU textures.
    pub fn set_texture_ceiling(&mut self, max_series: u32) {
        self.ceiling = Some(max_series);
    }

    pub fn set_load_failed(&mut self) {
        self.load_failed = true;
    }

    pub fn controller_mut(&mut self) -> &mut Controller {
        &mut self.controller
    }

    /// Advances inertia to main-thread time `t_main_ms`.
    pub fn step(&mut self, t_main_ms: f64) {
        self.controller.step(t_main_ms);
    }

    /// Series drawn: added, capped by the texture ceiling.
    fn drawn(&self) -> u32 {
        (self.series.len() as u32).min(self.ceiling.unwrap_or(u32::MAX))
    }

    /// The frame's uniforms, columns and gridlines; `None` until a layer, a canvas and a series.
    pub fn frame(&self, layout: &LayoutInfo) -> Option<LineFrame> {
        let layer = self.layer?;
        let (plot, dpr) = self.plot()?;
        let drawn = self.drawn();
        if drawn == 0 {
            return None;
        }
        let (css_w, css_h, _) = self.canvas?;
        let cam = self.controller.camera();
        let step = layer.step_ms as f64;
        let xmap = XMap::new(step, cam.t_left_rel_ms, cam.ms_per_px);
        let columns = Columns::new(xmap, layer.n, plot.w);
        let width = (LINE_WIDTH_CSS * dpr).clamp(1.0, 6.0);
        let half_w = width / 2.0;
        let mut u: LineUniforms = bytemuck::Zeroable::zeroed();
        u.canvas_px = canvas_px(css_w, css_h, dpr);
        u.plot_origin_px = [plot.x0, plot.y0];
        u.plot_size_px = [plot.w as f32, plot.h as f32];
        u.c0 = xmap.c0;
        u.s = xmap.s;
        u.a_y = (1.0 / cam.v_per_px) as f32;
        u.half_w = half_w;
        u.slots = columns.slots();
        u.margin = MARGIN;
        u.radius = (half_w - 0.5).ceil().max(0.0) as u32;
        u.series = drawn;
        u.n = layer.n;
        u.tex_w = layout.tex_w;
        u.levels = layout.levels;
        u.k0 = xmap.k0;
        u.k_l = columns.k_l.unwrap_or(u32::MAX);
        u.k_r = columns.k_r.unwrap_or(u32::MAX);
        u.colour = LINE;
        u.pyr_base = layout.pyr_base;
        u.pyr_len = layout.pyr_len;
        for (i, p) in self.series.iter().take(drawn as usize).enumerate() {
            u.set_d(i as u32, (p.v_ref - cam.v_bottom) as f32);
        }
        let t0 = layer.start_ms as f64 + cam.t_left_rel_ms;
        let grid = segments(
            (t0, t0 + f64::from(plot.w) * cam.ms_per_px),
            (
                cam.v_bottom,
                cam.v_bottom + f64::from(plot.h) * cam.v_per_px,
            ),
            true,
            &plot,
            dpr,
        );
        Some(LineFrame {
            uniforms: Box::new(u),
            columns,
            plot,
            grid,
        })
    }

    /// Requested, held and drawn series, and why they differ (§4.6).
    pub fn coverage(&self) -> LineCoverage {
        let (requested, held) = self.layer.map_or((0, 0), |l| (l.requested, l.held));
        let drawn = self.drawn();
        let cap = held.min(self.ceiling.unwrap_or(u32::MAX));
        let mut reasons = Vec::new();
        if drawn < cap && !self.load_failed {
            reasons.push(CoverageReason::Loading);
        }
        if held < requested {
            reasons.push(CoverageReason::StCeiling);
        }
        if self.ceiling.is_some() {
            reasons.push(CoverageReason::TextureCeiling);
        }
        if self.load_failed {
            reasons.push(CoverageReason::LoadFailed);
        }
        LineCoverage {
            requested,
            held,
            drawn,
            reasons,
        }
    }
}

impl InputSink for LineScene {
    /// Resize sets the canvas; every other record goes to the camera controller.
    fn apply(&mut self, h: &RecordHeader, r: &InputRecord) {
        if let InputRecord::Resize {
            css_w, css_h, dpr, ..
        } = *r
        {
            self.set_canvas(css_w, css_h, dpr);
            return;
        }
        if let Some((plot, dpr)) = self.plot() {
            self.controller.apply(h, r, &plot, dpr);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dash_protocol::input::InputRecord;

    fn layer(n: u32, requested: u32, held: u32) -> LayerInfo {
        LayerInfo {
            start_ms: 0,
            step_ms: 10,
            n,
            requested,
            held,
        }
    }

    fn prepared(v_ref: f64, min: f64, max: f64) -> Prepared {
        Prepared { v_ref, min, max }
    }

    const LAYOUT: LayoutInfo = LayoutInfo {
        tex_w: 4_096,
        levels: 2,
        pyr_base: [0, 100, 0, 0],
        pyr_len: [63, 4, 0, 0],
    };

    #[test]
    fn line_uniforms_layout() {
        use std::mem::{offset_of, size_of};
        assert_eq!(size_of::<LineUniforms>(), 4_240);
        assert_eq!(offset_of!(LineUniforms, colour), 80);
        assert_eq!(offset_of!(LineUniforms, pyr_base), 96);
        assert_eq!(offset_of!(LineUniforms, pyr_len), 112);
        assert_eq!(offset_of!(LineUniforms, tile_w), 128);
        assert_eq!(offset_of!(LineUniforms, series_d), 144);
        let mut u: LineUniforms = bytemuck::Zeroable::zeroed();
        let ids = [0u32, 3, 4, 5, 999, 1023];
        for i in ids {
            u.set_d(i, i as f32);
        }
        let bytes = bytemuck::bytes_of(&u);
        for i in ids {
            let at = 144 + 4 * i as usize;
            let v = f32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
            assert_eq!(v, i as f32, "series {i}");
            assert_eq!(u.d(i), i as f32);
        }
    }

    #[test]
    fn line_frame_values() {
        let mut s = LineScene::new();
        assert!(s.frame(&LAYOUT).is_none());
        s.set_layer(layer(1_000, 2, 2));
        s.add_series(prepared(100.0, 90.0, 110.0));
        s.add_series(prepared(-5.0, -10.0, 0.0));
        assert!(s.frame(&LAYOUT).is_none(), "no canvas yet");
        s.set_canvas(856.0, 432.0, 1.0);
        let l = *s.controller_mut().limits();
        s.controller_mut().set_camera(
            Camera2d {
                t_left_rel_ms: 0.0,
                ms_per_px: 10.0,
                v_bottom: -10.0,
                v_per_px: 0.5,
            },
            l,
        );
        let f = s.frame(&LAYOUT).unwrap();
        assert_eq!(
            f.plot,
            Plot {
                x0: 48.0,
                y0: 24.0,
                w: 800,
                h: 400
            }
        );
        let u = &f.uniforms;
        assert_eq!((u.k0, u.c0, u.s), (0, 0.0, 1.0));
        assert_eq!(u.a_y, 2.0);
        assert_eq!((u.d(0), u.d(1)), (110.0, 5.0));
        assert_eq!(u.slots, 810);
        assert_eq!(f.columns.slots(), 810);
        assert_eq!(u.radius, 0);
        assert_eq!(u.half_w, 0.5);
        assert_eq!(u.series, 2);
        assert_eq!(u.n, 1_000);
        assert_eq!(u.canvas_px, [856.0, 432.0]);
        assert_eq!(u.plot_origin_px, [48.0, 24.0]);
        assert_eq!(u.plot_size_px, [800.0, 400.0]);
        assert_eq!((u.tex_w, u.levels), (4_096, 2));
        assert_eq!((u.k_l, u.k_r), (u32::MAX, 804));
        assert_eq!(u.margin, 4);
        assert_eq!(u.colour, dash_tokens::spike::LINE);
        assert!(!f.grid.is_empty());
    }

    #[test]
    fn coverage_reasons() {
        let mut s = LineScene::new();
        s.set_layer(layer(100, 1_000, 100));
        for i in 0..40 {
            s.add_series(prepared(f64::from(i), 0.0, 1.0));
        }
        let c = s.coverage();
        assert_eq!((c.requested, c.held, c.drawn), (1_000, 100, 40));
        assert_eq!(c.ids(), "loading st-ceiling");
        s.set_texture_ceiling(30);
        assert_eq!(s.coverage().drawn, 30);
        assert_eq!(s.coverage().ids(), "st-ceiling texture-ceiling");
        s.set_load_failed();
        assert_eq!(s.coverage().ids(), "st-ceiling texture-ceiling load-failed");
        let mut full = LineScene::new();
        full.set_layer(layer(100, 3, 3));
        for _ in 0..3 {
            full.add_series(prepared(0.0, -1.0, 1.0));
        }
        assert_eq!(full.coverage().ids(), "");
        assert!(full.coverage().reasons.is_empty());
    }

    #[test]
    fn autofit_until_user_moves() {
        let mut s = LineScene::new();
        s.set_layer(layer(1_000, 3, 3));
        s.set_canvas(856.0, 432.0, 1.0);
        s.add_series(prepared(0.0, -1.0, 1.0));
        let one = *s.controller_mut().camera();
        assert_eq!(one.ms_per_px, 12.5);
        s.add_series(prepared(5.0, 0.0, 10.0));
        let two = *s.controller_mut().camera();
        assert_ne!(two, one, "refit after the 2nd series");
        assert_eq!(two.v_bottom, -1.0 - 0.05 * 11.0);
        let h = RecordHeader {
            kind: 5,
            flags: 0,
            size: 40,
            seq: 1,
            t_ms: 1.0,
        };
        let w = InputRecord::Wheel {
            x: 400.0,
            y: 200.0,
            dx: 0.0,
            dy: -120.0,
            mods: 0,
            mode: 0,
        };
        InputSink::apply(&mut s, &h, &w);
        let zoomed = *s.controller_mut().camera();
        assert_ne!(zoomed, two);
        s.add_series(prepared(50.0, 0.0, 100.0));
        assert_eq!(
            *s.controller_mut().camera(),
            zoomed,
            "no refit after the user moved"
        );
    }
}
