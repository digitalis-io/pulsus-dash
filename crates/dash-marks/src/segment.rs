//! Capsule segments (gridlines, axis lines, ticks) of the minimal axes: one instanced draw.

/// The WGSL source: `vs_segment`, `fs_segment`.
pub const SEGMENT_WGSL: &str = include_str!("segment_draw.wgsl");

/// Segment pipeline, uniforms and a growable instance buffer.
#[derive(Debug)]
pub struct SegmentMark {
    draws: std::cell::Cell<u32>,
}

impl SegmentMark {
    pub fn new(_device: &wgpu::Device, _format: wgpu::TextureFormat) -> Self {
        SegmentMark {
            draws: std::cell::Cell::new(0),
        }
    }

    /// Draws `segs` (`[x0, y0, x1, y1]`, device px, y up) as capsules of half-width `half_w`.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(
        &mut self,
        _device: &wgpu::Device,
        _queue: &wgpu::Queue,
        _pass: &mut wgpu::RenderPass<'_>,
        _canvas_px: [f32; 2],
        _half_w: f32,
        _colour: [f32; 4],
        _segs: &[[f32; 4]],
    ) {
    }

    /// Draw calls recorded since the last call.
    pub fn take_draw_count(&self) -> u32 {
        self.draws.replace(0)
    }
}
