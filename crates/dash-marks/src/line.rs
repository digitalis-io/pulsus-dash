//! The M1 line mark (plan #24 §3.5, §4.3, §4.4): value and pyramid textures, the GPU decimation
//! pass (T1 compute, T2 render-to-texture) and the column-coverage draw.

use dash_scales::lod::{Pyramid, SlotRecord};
use dash_scene::line::{LayoutInfo, LineFrame};

/// Shared declarations and the decimation walk.
pub const LINE_COMMON_WGSL: &str = include_str!("line_common.wgsl");
/// T1 decimation: `cs_decimate`.
pub const LINE_DECIMATE_CS_WGSL: &str = concat!(
    include_str!("line_common.wgsl"),
    include_str!("line_decimate_cs.wgsl")
);
/// T2 decimation: `vs_fullscreen`, `fs_decimate`.
pub const LINE_DECIMATE_FS_WGSL: &str = concat!(
    include_str!("line_common.wgsl"),
    include_str!("line_decimate_fs.wgsl")
);
/// The draw: `vs_line`, `fs_line`, `fs_mask`.
pub const LINE_DRAW_WGSL: &str = concat!(
    include_str!("line_common.wgsl"),
    include_str!("line_draw.wgsl")
);

/// Bytes per sample of the Fragment targets (`Rgba32Uint` × 2), checked against the limit.
pub const FRAGMENT_TARGET_BYTES: u32 = 32;

/// How the records are computed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecimatePath {
    /// T1: a compute pass writing storage textures.
    Compute,
    /// T2: a render pass into two `Rgba32Uint` targets.
    Fragment,
}

/// Why a layout does not fit the device.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayoutError {
    TooLarge { max_series: u32 },
}

/// Texture layout of the values and the pyramid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineLayout {
    pub series: u32,
    pub n: u32,
    pub tex_w: u32,
    pub value_layers: u32,
    pub pyr_layers: u32,
    pub levels: u32,
    pub pyr_base: [u32; 4],
    pub pyr_len: [u32; 4],
}

impl LineLayout {
    pub fn new(
        _series: u32,
        _n: u32,
        _max_dim: u32,
        _max_layers: u32,
    ) -> Result<LineLayout, LayoutError> {
        Err(LayoutError::TooLarge { max_series: 0 })
    }

    pub fn info(&self) -> LayoutInfo {
        LayoutInfo {
            tex_w: self.tex_w,
            levels: self.levels,
            pyr_base: self.pyr_base,
            pyr_len: self.pyr_len,
        }
    }
}

/// A row-aligned piece of a linear texel range.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TexRect {
    pub x: u32,
    pub y: u32,
    pub layer: u32,
    pub w: u32,
    pub h: u32,
    /// Offset of the piece's first texel in the source.
    pub src: usize,
}

pub fn linear_rects(_start: u64, _len: u64, _tex_w: u32) -> Vec<TexRect> {
    Vec::new()
}

/// The line mark's GPU state.
#[derive(Debug)]
pub struct LineMark {
    draws: std::cell::Cell<u32>,
}

impl LineMark {
    pub fn new(
        _device: &wgpu::Device,
        _format: wgpu::TextureFormat,
        _layout: LineLayout,
        _path: DecimatePath,
        _slots: u32,
        _max_dim: u32,
    ) -> LineMark {
        LineMark {
            draws: std::cell::Cell::new(0),
        }
    }

    pub fn upload_series(&self, _queue: &wgpu::Queue, _i: u32, _bits: &[u32], _pyramid: &Pyramid) {}

    pub fn set_frame(&mut self, _device: &wgpu::Device, _queue: &wgpu::Queue, _f: &LineFrame) {}

    pub fn decimate(&self, _encoder: &mut wgpu::CommandEncoder) {}

    pub fn draw(&self, _pass: &mut wgpu::RenderPass<'_>) {}

    pub fn write_records(
        &self,
        _queue: &wgpu::Queue,
        _recs: &[SlotRecord],
        _ks: &[u32],
        _series: u32,
    ) {
    }

    pub fn draw_mask(&self, _pass: &mut wgpu::RenderPass<'_>) {}

    pub fn record_textures(&self) -> [&wgpu::Texture; 2] {
        unreachable!("stub")
    }

    pub fn take_draw_count(&self) -> u32 {
        self.draws.replace(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::segment::SEGMENT_WGSL;

    fn validate(src: &str) -> (naga::Module, naga::valid::ModuleInfo) {
        let m = naga::front::wgsl::parse_str(src).expect("WGSL parses");
        let info = naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(&m)
        .expect("WGSL validates");
        (m, info)
    }

    fn entries(m: &naga::Module) -> Vec<&str> {
        m.entry_points.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn line_wgsl_validates() {
        for (src, want) in [
            (LINE_DECIMATE_CS_WGSL, vec!["cs_decimate"]),
            (LINE_DECIMATE_FS_WGSL, vec!["vs_fullscreen", "fs_decimate"]),
            (LINE_DRAW_WGSL, vec!["vs_line", "fs_line", "fs_mask"]),
            (SEGMENT_WGSL, vec!["vs_segment", "fs_segment"]),
        ] {
            let (m, _) = validate(src);
            assert_eq!(entries(&m), want);
        }
        assert_eq!(
            LINE_COMMON_WGSL
                .matches("const PYRAMID_B: u32 = 16u;")
                .count(),
            1
        );
    }

    #[test]
    fn line_fragment_modules_to_glsl_es300() {
        for src in [LINE_DECIMATE_FS_WGSL, LINE_DRAW_WGSL, SEGMENT_WGSL] {
            let (m, info) = validate(src);
            assert!(!m.entry_points.is_empty());
            for e in &m.entry_points {
                let options = naga::back::glsl::Options {
                    version: naga::back::glsl::Version::Embedded {
                        version: 300,
                        is_webgl: true,
                    },
                    ..Default::default()
                };
                let pipeline = naga::back::glsl::PipelineOptions {
                    shader_stage: e.stage,
                    entry_point: e.name.clone(),
                    multiview: None,
                };
                let mut out = String::new();
                let mut w = naga::back::glsl::Writer::new(
                    &mut out,
                    &m,
                    &info,
                    &options,
                    &pipeline,
                    naga::proc::BoundsCheckPolicies::default(),
                )
                .expect("GLSL writer");
                w.write().unwrap_or_else(|err| panic!("{}: {err}", e.name));
                assert!(out.starts_with("#version 300 es"), "{out}");
            }
        }
    }

    #[test]
    fn linear_rects_split() {
        let t = |v: &[TexRect]| -> Vec<(u32, u32, u32, u32, u32, usize)> {
            v.iter()
                .map(|r| (r.x, r.y, r.layer, r.w, r.h, r.src))
                .collect()
        };
        assert_eq!(
            t(&linear_rects(4_090, 10, 4_096)),
            vec![(4_090, 0, 0, 6, 1, 0), (0, 1, 0, 4, 1, 6)]
        );
        assert_eq!(
            t(&linear_rects(4_096 * 4_096 - 2, 4, 4_096)),
            vec![(4_094, 4_095, 0, 2, 1, 0), (0, 0, 1, 2, 1, 2)]
        );
        assert_eq!(
            t(&linear_rects(0, 3 * 4_096 + 5, 4_096)),
            vec![(0, 0, 0, 4_096, 3, 0), (0, 3, 0, 5, 1, 12_288)]
        );
        // Full rows stop at a layer boundary.
        assert_eq!(
            t(&linear_rects(4 * 3, 4 * 4, 4)),
            vec![(0, 3, 0, 4, 1, 0), (0, 0, 1, 4, 3, 4)]
        );
        assert!(linear_rects(5, 0, 4).is_empty());
    }

    #[test]
    fn line_layout_sizes() {
        let l = LineLayout::new(1_000, 100_000, 8_192, 256).unwrap();
        assert_eq!(
            (l.tex_w, l.value_layers, l.pyr_layers, l.levels),
            (4_096, 6, 1, 4)
        );
        assert_eq!(l.pyr_len, [6_250, 391, 25, 2]);
        assert_eq!(l.pyr_base, [0, 6_250_000, 6_641_000, 6_666_000]);
        assert_eq!(l.series, 1_000);
        assert_eq!(l.info().pyr_base, l.pyr_base);
        assert_eq!(
            LineLayout::new(1_000, 100_000, 2_048, 16),
            Err(LayoutError::TooLarge { max_series: 671 })
        );
        assert_eq!(
            LineLayout::new(1_000, 100_000, 512, 256),
            Err(LayoutError::TooLarge { max_series: 512 })
        );
        let small = LineLayout::new(8, 16, 8_192, 256).unwrap();
        assert_eq!((small.levels, small.pyr_len), (0, [0; 4]));
    }
}
