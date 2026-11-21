//! The line renderer (plan #68 §4.1, §4.2, A.11, A.15).

use dash_gpu::{FrameTarget, GpuContext};
use dash_scales::ColumnRanges;
use dash_scales::decimate::{Decimated, LineInstance};
use dash_scales::encode::Encoding;
use dash_wire::ChunkId;

use crate::desc::{DrawList, DrawnEvent};

#[derive(Clone, Copy, Debug, Default)]
pub struct RendererOptions {
    /// Test hook: force batching.
    pub max_instances: Option<u64>,
}

/// Test hook counters (A.15.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DebugCounters {
    pub ranges_builds: u64,
    pub value_encodes: u64,
    pub staging_bytes_max: u64,
}

#[derive(Debug)]
pub struct Renderer {
    format: wgpu::TextureFormat,
    opts: RendererOptions,
}

impl Renderer {
    pub fn new(ctx: &GpuContext, format: wgpu::TextureFormat, opts: RendererOptions) -> Self {
        let _ = ctx;
        Self { format, opts }
    }

    /// Some(DrawnEvent) when the frame was drawn completely at a non-zero size (D-DRAWN).
    pub fn render(
        &mut self,
        ctx: &GpuContext,
        list: &DrawList,
        target: &mut dyn FrameTarget,
    ) -> Option<DrawnEvent> {
        let _ = (ctx, list, target, self.format, self.opts);
        None
    }

    /// Test hook: draw `list` with the Line item's instances replaced by `instances`.
    pub fn render_instances(
        &mut self,
        ctx: &GpuContext,
        list: &DrawList,
        instances: &[LineInstance],
        target: &mut dyn FrameTarget,
    ) {
        let _ = (ctx, list, instances, target);
    }

    /// Test hook: the decimation buffers of the last Line item, read back.
    pub fn read_decimation(&self, ctx: &GpuContext) -> Option<Decimated> {
        let _ = ctx;
        None
    }

    /// Test hook: the column ranges of the last Line item (read back from the GPU on T1).
    pub fn debug_ranges(&self, ctx: &GpuContext) -> Option<ColumnRanges> {
        let _ = ctx;
        None
    }

    /// Draw calls issued by the last render.
    pub fn last_draws(&self) -> u32 {
        0
    }

    pub fn debug_counters(&self) -> DebugCounters {
        DebugCounters::default()
    }

    /// Resident encoded-value buffers (GPU on T1, CPU on T2): (chunk, encoding, bytes).
    pub fn debug_resident(&self) -> Vec<(ChunkId, Encoding, u64)> {
        Vec::new()
    }
}
