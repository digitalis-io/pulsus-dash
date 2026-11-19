//! The line chart scene (plan #24 §3.4): layer, series ranges, fit, camera and the per-frame
//! uniforms of the M1 line mark.

use dash_axes::minimal::Plot;
use dash_protocol::input::{InputRecord, RecordHeader};
use dash_scales::lod::{Columns, Prepared, XMap};

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
        String::new()
    }
}

/// The line mark's uniform block (4 240 bytes).
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
    /// Sets series `i`'s y offset (`series_d[i >> 2][i & 3]`).
    pub fn set_d(&mut self, _i: u32, _d: f32) {}

    pub fn d(&self, _i: u32) -> f32 {
        0.0
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
    pub grid: Vec<[f32; 4]>,
}

/// The plot rectangle of a canvas (`PLOT_INSET_CSS`).
pub fn plot_rect(_css_w: f32, _css_h: f32, _dpr: f32) -> Plot {
    Plot {
        x0: 0.0,
        y0: 0.0,
        w: 0,
        h: 0,
    }
}

/// The line chart scene.
#[derive(Debug)]
pub struct LineScene {
    controller: Controller,
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
            v_bottom: 0.0,
            v_per_px: 1.0,
        };
        let l = Limits {
            min_ms_per_px: 1.0,
            max_ms_per_px: 1.0,
            min_v_per_px: 1.0,
            max_v_per_px: 1.0,
            t_range: (0.0, 0.0),
            v_range: (0.0, 0.0),
        };
        LineScene {
            controller: Controller::new(c, l),
        }
    }

    pub fn set_canvas(&mut self, _css_w: f32, _css_h: f32, _dpr: f32) {}

    pub fn set_layer(&mut self, _l: LayerInfo) {}

    /// Adds the next series (in id order).
    pub fn add_series(&mut self, _p: Prepared) {}

    pub fn set_texture_ceiling(&mut self, _max_series: u32) {}

    pub fn set_load_failed(&mut self) {}

    pub fn controller_mut(&mut self) -> &mut Controller {
        &mut self.controller
    }

    pub fn step(&mut self, t_main_ms: f64) {
        self.controller.step(t_main_ms);
    }

    /// `None` until a layer, a canvas and a series exist.
    pub fn frame(&self, _layout: &LayoutInfo) -> Option<LineFrame> {
        let _ = XMap::new(1.0, 0.0, 1.0);
        None
    }

    pub fn coverage(&self) -> LineCoverage {
        LineCoverage {
            requested: 0,
            held: 0,
            drawn: 0,
            reasons: Vec::new(),
        }
    }
}

impl InputSink for LineScene {
    fn apply(&mut self, _h: &RecordHeader, _r: &InputRecord) {}
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
