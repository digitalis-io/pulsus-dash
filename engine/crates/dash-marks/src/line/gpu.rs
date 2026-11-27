//! The line renderer (plan #68 §4.1, §4.2, A.11, A.15): the T1 compute passes P1–P5 with sizing
//! and ordered batching, the CPU path (`dash-scales::decimate`) for T2 and for far items, and one
//! capsule pipeline for both.
//!
//! Buffer lifetimes (A.15.1): encoded values are keyed (ChunkId, Encoding) and every key the draw
//! list does not reference is released before anything is allocated (L1, L4); values are encoded
//! through one reusable 16 MiB slab (L2); `ColOut`, counts, starts and status grow with the item and
//! are never shrunk, the instance buffer grows to a power of two ≥ the frame's instances (L3).
//! Column ranges are cached by (chunk, series, window, columns, DPR), so a theme or value-range
//! change never rebuilds them, and a pan, zoom or resize never re-encodes values.
//!
//! Sync (plan #68 C1 §3.1): `Block` (native) waits for uploads, batches and the status read-back;
//! `Defer` (the browser) never waits: queue order alone orders uploads and batches, and a T1 item
//! whose total is not known yet is drawn within the current capacity while the status header is
//! read back with `map_async` (`defer.rs`, [`Renderer::poll`]). On T2 no compute pipeline and no
//! storage or indirect buffer exist.
//!
//! The overlay (plan #68 C2b): a `MarkItem::Overlay` is drawn after every line and guide of the
//! list, in its own pass (`crate::overlay`), never scissored.
//!
//! The selection (plan #68 C2c2): a Line item with an emphasis is drawn in the lane passes of
//! `passes.rs`, the unmatched series through the dim layer; without one, in one pass as before.

use dash_gpu::{FrameTarget, GpuContext, Tier};
use dash_scales::decimate::{
    ColOut, Decimated, INST_KIND_SHIFT, INST_LANE_SHIFT, INST_SLOT, KIND_HLINE, LineInstance,
};
use dash_scales::encode::Encoding;
use dash_scales::{ColumnRanges, column_ranges};
use dash_wire::{Chunk, ChunkId};

use super::defer::{Readback, TotalKey};
use super::passes::{Composite, DimLayer, Pass, PassKind, Target, lanes_of};
use super::pipeline::{Pipelines, pipelines};
use super::t1::Compute;
use crate::desc::{DrawList, DrawnEvent, MarkItem};
use crate::overlay::Overlay;

/// The L2 staging slab: 16 MiB of encoded values.
pub(super) const STAGING_WORDS: usize = (16 << 20) / 4;
/// The instance buffer starts at 2^20 instances (capped at `max_instances`).
const MIN_INSTANCES: u64 = 1 << 20;
/// u32 words of `status` before the per-series base metas: draw-indirect args, total, padding.
pub(super) const STATUS_HEADER: u64 = 8;
pub(super) const INSTANCE_BYTES: u64 = 16;
pub(super) const COL_BYTES: u64 = 40;
/// The guide colour slot.
const GRID_SLOT: u32 = 8;

/// How the renderer waits for the GPU (plan #68 C1 §3.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Sync {
    /// Native: block on uploads, batches and the status read-back.
    #[default]
    Block,
    /// The browser: never block; read the status back with `map_async` and report through
    /// [`Renderer::poll`].
    Defer,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct RendererOptions {
    /// Test hook: force batching below the device limit.
    pub max_instances: Option<u64>,
    pub sync: Sync,
}

/// The state of a deferred status read-back (`Sync::Defer`).
#[derive(Debug, PartialEq)]
pub enum Pending {
    /// Nothing outstanding.
    Idle,
    /// The read-back has not completed yet.
    Waiting,
    /// The frame drawn last was complete.
    Complete(DrawnEvent),
    /// The frame was under-sized or its read-back failed: draw it again.
    Rerun,
    /// The third read-back in a row failed.
    Failed,
}

/// Test hook counters (A.15.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DebugCounters {
    /// Column-range tables computed.
    pub ranges_builds: u64,
    /// (chunk, encoding) value slabs encoded.
    pub value_encodes: u64,
    /// The largest staging slice written (T1); 0 on T2, where the slab is the input.
    pub staging_bytes_max: u64,
    /// Peak value-upload bytes queued and not yet completed (L2: one slice, ≤ 16 MiB).
    pub staging_outstanding_max: u64,
    /// Peak bytes of CPU-path instance batches held at once (T2 and far items).
    pub cpu_instance_bytes_peak: u64,
    /// Value-upload slices submitted to the queue.
    pub value_slices_submitted: u64,
    /// Compute pipelines created (0 on T2).
    pub compute_pipelines: u32,
    /// Buffers created with STORAGE or INDIRECT usage (0 on T2).
    pub storage_buffers: u32,
}

/// The P1–P5 uniform.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub(super) struct PassU {
    pub(super) n: u32,
    pub(super) series: u32,
    pub(super) per_series_ranges: u32,
    pub(super) guides: u32,
    pub(super) window_lo: u32,
    pub(super) window_hi: u32,
    pub(super) pad: [u32; 2],
}

/// The draw uniform (`line.wgsl` `View`, 288 bytes; plan #68 C2c2 appends the pass fields).
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct ViewU {
    view_proj: [[f32; 4]; 4],
    device_px: [f32; 2],
    dpr: f32,
    width_css: f32,
    plot: [f32; 4],
    ku: f32,
    ou: f32,
    lane_z0: f32,
    lane_dz: f32,
    colours: [[f32; 4]; 10],
    lane_only: u32,
    guides: u32,
    use_colour: u32,
    area_alpha: f32,
    colour: [f32; 4],
}

/// A buffer that grows on demand and is never shrunk (L3).
#[derive(Debug)]
pub(super) struct Grow {
    label: &'static str,
    usage: wgpu::BufferUsages,
    pub(super) buf: wgpu::Buffer,
}

impl Grow {
    pub(super) fn new(
        ctx: &GpuContext,
        label: &'static str,
        usage: wgpu::BufferUsages,
        size: u64,
        counters: &mut DebugCounters,
    ) -> Self {
        let buf = create(ctx, label, usage, size, counters);
        Self { label, usage, buf }
    }

    /// Reallocates when `size` exceeds the current size.
    pub(super) fn ensure(&mut self, ctx: &GpuContext, size: u64, counters: &mut DebugCounters) {
        if size > self.buf.size() {
            self.buf = create(ctx, self.label, self.usage, size, counters);
        }
    }
}

/// A buffer; STORAGE and INDIRECT ones are counted (T2 has none, plan #68 C1 §3.1).
pub(super) fn create(
    ctx: &GpuContext,
    label: &str,
    usage: wgpu::BufferUsages,
    size: u64,
    counters: &mut DebugCounters,
) -> wgpu::Buffer {
    if usage.intersects(wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::INDIRECT) {
        counters.storage_buffers += 1;
    }
    ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some(label),
        size: size.max(16).next_multiple_of(4),
        usage,
        mapped_at_creation: false,
    })
}

/// Encoded values of one (chunk, encoding): on the GPU for the T1 compute path, in CPU memory for
/// the CPU path (T2 and far items).
#[derive(Debug)]
pub(super) struct Resident {
    chunk: ChunkId,
    enc: Encoding,
    len: u64,
    pub(super) gpu: Option<wgpu::Buffer>,
    cpu: Option<Vec<u32>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RangesKey {
    chunk: ChunkId,
    series: (u32, u32),
    window: (u64, u64),
    n: u32,
    dpr: u32,
}

#[derive(Debug)]
pub(super) struct RangesCache {
    key: RangesKey,
    pub(super) ranges: ColumnRanges,
    /// The key whose table is in the GPU ranges buffer.
    pub(super) uploaded: Option<RangesKey>,
}

/// What `read_decimation` reads back.
#[derive(Debug)]
pub(super) enum LastLine {
    Gpu {
        series: u32,
        n: u32,
        total: u64,
        all: u64,
    },
    Cpu(Decimated),
}

/// How a render pass draws its instances.
#[derive(Clone, Copy, Debug)]
pub(super) enum Draw {
    Direct(u32),
    /// `status[0..4]`, written by P3 (one batch only).
    Indirect,
}

/// Where a frame goes: its view, device size and whether the next pass clears; the target of the
/// pass being drawn, and the dim layer's view and whether its next pass clears it.
pub(super) struct Frame<'a> {
    pub(super) list: &'a DrawList,
    view: wgpu::TextureView,
    size: (u32, u32),
    first: bool,
    pub(super) target: Target,
    dim: Option<wgpu::TextureView>,
    dim_first: bool,
}

/// The line renderer. One per device; it owns the pipelines, the per-item buffers and the
/// resident encoded values.
#[derive(Debug)]
pub struct Renderer {
    format: wgpu::TextureFormat,
    pub(super) opts: RendererOptions,
    p: Pipelines,
    view_buf: wgpu::Buffer,
    /// The T1 compute passes and their buffers; `None` on T2.
    pub(super) compute: Option<Compute>,
    pub(super) instances: Grow,
    pub(super) resident: Vec<Resident>,
    staging: Vec<u32>,
    pub(super) ranges_cache: Option<RangesCache>,
    pub(super) counters: DebugCounters,
    draws: u32,
    pub(super) last: Option<LastLine>,
    /// The GPU error that ended the last render early, if any.
    pub(super) error: Option<dash_gpu::GpuError>,
    /// `Defer`: the T1 total of the last line item read back, by what it depends on.
    pub(super) known: Option<(TotalKey, u64)>,
    /// `Defer`: the outstanding status read-back of the last render.
    pub(super) pending: Option<Readback>,
    /// `Defer`: set by a render that left its completeness to the read-back.
    pub(super) awaiting: bool,
    /// `Defer`: read-backs that failed in a row.
    pub(super) read_failures: u32,
    /// The decimated total of the last line item (guides excluded).
    pub(super) total: Option<u64>,
    /// The overlay pipeline (plan #68 C2b).
    overlay: Overlay,
    /// The dim layer while a list has an emphasis, and its composite (plan #68 C2c2).
    pub(super) dim: Option<DimLayer>,
    pub(super) composite: Composite,
    /// The passes of the last render (test hook).
    pub(super) passes: Vec<PassKind>,
}

/// The fields of a `MarkItem::Line`.
pub(super) struct LineRef<'a> {
    pub(super) chunk: &'a std::sync::Arc<Chunk>,
    pub(super) series: &'a std::ops::Range<u32>,
    window: (f64, f64),
    pub(super) n: u32,
    pub(super) encoding: Encoding,
    pub(super) plot: [f32; 4],
    pub(super) axis: (f32, f32),
    pub(super) colour_slots: &'a [u8],
    pub(super) lanes: Option<&'a [u16]>,
    pub(super) width_css: f32,
    pub(super) far: bool,
    pub(super) emphasis: Option<&'a crate::desc::Emphasis>,
}

impl<'a> LineRef<'a> {
    fn of(item: &'a MarkItem) -> Option<Self> {
        match item {
            MarkItem::Line {
                chunk,
                series,
                window,
                n,
                plot,
                encoding,
                axis,
                colour_slots,
                lanes,
                width_css,
                far,
                emphasis,
                ..
            } => Some(Self {
                chunk,
                series,
                window: *window,
                n: *n,
                plot: *plot,
                encoding: *encoding,
                axis: *axis,
                colour_slots,
                lanes: lanes.as_deref(),
                width_css: *width_css,
                far: *far,
                emphasis: emphasis.as_ref(),
            }),
            MarkItem::Guides { .. } | MarkItem::Overlay { .. } => None,
        }
    }

    pub(super) fn series_count(&self) -> u32 {
        self.series.end.saturating_sub(self.series.start)
    }

    /// slot | lane << 16 per series (the lanes of `passes::lanes_of`).
    pub(super) fn slot_lanes(&self) -> Vec<u32> {
        lanes_of(self)
            .into_iter()
            .enumerate()
            .map(|(s, lane)| {
                let slot = u32::from(self.colour_slots.get(s).copied().unwrap_or(0)) & INST_SLOT;
                slot | (u32::from(lane) << INST_LANE_SHIFT)
            })
            .collect()
    }
}

fn guide_instances(lines: &[f32]) -> impl Iterator<Item = LineInstance> + '_ {
    let meta = GRID_SLOT | (KIND_HLINE << INST_KIND_SHIFT);
    lines.iter().map(move |y| LineInstance {
        col: 0,
        va: *y,
        vb: 0.0,
        meta,
    })
}

/// The device-px scissor of a CSS plot rect (`round(x·dpr)` …), clamped to the target.
fn scissor(clip: [f32; 4], dpr: f32, (w, h): (u32, u32)) -> (u32, u32, u32, u32) {
    let px = |v: f32| (v * dpr).round().max(0.0) as u32;
    let (x0, y0) = (px(clip[0]).min(w), px(clip[1]).min(h));
    let (x1, y1) = (px(clip[0] + clip[2]).min(w), px(clip[1] + clip[3]).min(h));
    (x0, y0, x1.saturating_sub(x0), y1.saturating_sub(y0))
}

impl Renderer {
    pub fn new(ctx: &GpuContext, format: wgpu::TextureFormat, opts: RendererOptions) -> Self {
        use wgpu::BufferUsages as U;
        let cap = MIN_INSTANCES.min(opts.max_instances.unwrap_or(ctx.max_instances).max(1));
        let uniform = U::UNIFORM | U::COPY_DST;
        let mut counters = DebugCounters::default();
        let (compute, instance_usage) = match ctx.tier {
            Tier::T1 => (
                Some(Compute::new(ctx, &mut counters)),
                U::STORAGE | U::COPY_DST | U::COPY_SRC | U::VERTEX,
            ),
            Tier::T2 => (None, U::VERTEX | U::COPY_DST),
        };
        let view_bytes = std::mem::size_of::<ViewU>() as u64;
        let view_buf = create(ctx, "view", uniform, view_bytes, &mut counters);
        let instances = Grow::new(
            ctx,
            "instances",
            instance_usage,
            cap * INSTANCE_BYTES,
            &mut counters,
        );
        Self {
            format,
            opts,
            p: pipelines(ctx, format),
            overlay: Overlay::new(ctx, format),
            dim: None,
            composite: Composite::new(ctx, format),
            passes: Vec::new(),
            view_buf,
            compute,
            instances,
            resident: Vec::new(),
            staging: Vec::new(),
            ranges_cache: None,
            counters,
            draws: 0,
            last: None,
            error: None,
            known: None,
            pending: None,
            awaiting: false,
            read_failures: 0,
            total: None,
        }
    }

    pub(super) fn max_instances(&self, ctx: &GpuContext) -> u64 {
        self.opts.max_instances.unwrap_or(ctx.max_instances).max(1)
    }

    /// L1, L4: release every resident encoding no Line item of `list` draws from.
    fn release_unreferenced(&mut self, list: &DrawList) {
        self.resident.retain(|r| {
            list.items.iter().any(|i| match i {
                MarkItem::Line {
                    chunk, encoding, ..
                } => chunk.id == r.chunk && *encoding == r.enc,
                MarkItem::Guides { .. } | MarkItem::Overlay { .. } => false,
            })
        });
    }

    /// Some(DrawnEvent) when the frame was drawn completely at a non-zero size (D-DRAWN); a draw
    /// list with no item (no data, no window, an empty plot) clears and reports nothing.
    pub fn render(
        &mut self,
        ctx: &GpuContext,
        list: &DrawList,
        target: &mut dyn FrameTarget,
    ) -> Option<DrawnEvent> {
        self.release_unreferenced(list);
        self.draws = 0;
        self.error = None;
        // A newer render drops the previous frame's read-back.
        self.pending = None;
        self.awaiting = false;
        self.passes.clear();
        let size = target.size_px();
        if size.0 == 0 || size.1 == 0 || !(list.css.0 > 0.0 && list.css.1 > 0.0) {
            return None;
        }
        self.prepare_dim(ctx, list, size);
        let mut f = Frame {
            list,
            view: target.view(),
            size,
            first: true,
            target: Target::Frame,
            dim: self.dim.as_ref().map(|d| d.view.clone()),
            dim_first: true,
        };
        let complete = self.draw(ctx, &mut f, None);
        let drawn = (complete && !list.items.is_empty()).then_some(DrawnEvent {
            css_width: list.css.0,
            css_height: list.css.1,
            dpr: f64::from(list.dpr),
        });
        if self.awaiting {
            // `poll` reports it once the total is read back; an incomplete frame has no check.
            match (drawn, self.pending.as_mut()) {
                (Some(d), Some(p)) => p.drawn = Some(d),
                _ => self.pending = None,
            }
            return None;
        }
        drawn
    }

    /// Test hook: draw `list` (guides, clear, scissor and the Line item's View as `render` does),
    /// but replace the Line item's decimated instances with `instances` (no decimation pass runs).
    pub fn render_instances(
        &mut self,
        ctx: &GpuContext,
        list: &DrawList,
        instances: &[LineInstance],
        target: &mut dyn FrameTarget,
    ) {
        self.draws = 0;
        self.passes.clear();
        let size = target.size_px();
        if size.0 > 0 && size.1 > 0 {
            let mut f = Frame {
                list,
                view: target.view(),
                size,
                first: true,
                target: Target::Frame,
                dim: None,
                dim_first: true,
            };
            let _ = self.draw(ctx, &mut f, Some(instances));
        }
    }

    fn draw(&mut self, ctx: &GpuContext, f: &mut Frame, replace: Option<&[LineInstance]>) -> bool {
        let mut complete = true;
        let mut guides: Vec<LineInstance> = Vec::new();
        let mut guides_plot = [0.0f32; 4];
        for item in &f.list.items {
            if let MarkItem::Guides { lines, plot, .. } = item {
                guides.extend(guide_instances(lines));
                guides_plot = *plot;
                continue;
            }
            let Some(line) = LineRef::of(item) else {
                continue;
            };
            let g = std::mem::take(&mut guides);
            complete &= match replace {
                Some(raw) => {
                    let mut all = g;
                    all.extend_from_slice(raw);
                    self.write_view(ctx, f, line.plot, line.axis, &Pass::all(line.width_css));
                    self.draw_list(ctx, f, &all)
                }
                None => self.draw_line(ctx, f, &line, &g),
            };
        }
        if !guides.is_empty() {
            self.write_view(ctx, f, guides_plot, (0.0, 0.0), &Pass::all(0.0));
            complete &= self.draw_list(ctx, f, &guides);
        }
        // The overlay last, over everything, unclipped (plan #68 C2b §3.2).
        for item in &f.list.items {
            if let MarkItem::Overlay { shapes } = item
                && !shapes.is_empty()
            {
                let load = Self::load_op(f);
                self.overlay
                    .draw(ctx, &f.view, f.size, f.list.dpr, load, shapes);
            }
        }
        if f.first {
            let mut enc = ctx.device.create_command_encoder(&Default::default());
            drop(Self::begin_pass(&mut enc, f));
            ctx.queue.submit([enc.finish()]);
        }
        complete
    }

    /// The view uniform of pass `p` (its lane, guides, colour and width) over `plot` and `axis`.
    pub(super) fn write_view(
        &self,
        ctx: &GpuContext,
        f: &Frame,
        plot: [f32; 4],
        axis: (f32, f32),
        p: &Pass,
    ) {
        let v = ViewU {
            view_proj: f.list.view_proj,
            device_px: [f.size.0 as f32, f.size.1 as f32],
            dpr: f.list.dpr,
            width_css: p.width_css,
            plot,
            ku: axis.0,
            ou: axis.1,
            lane_z0: 0.0,
            lane_dz: 0.0,
            colours: f.list.palette.map(|c| c.to_f32()),
            lane_only: p.lane_only,
            guides: u32::from(p.guides),
            use_colour: u32::from(p.colour.is_some()),
            area_alpha: 0.0,
            colour: p.colour.unwrap_or([0.0; 4]),
        };
        ctx.queue
            .write_buffer(&self.view_buf, 0, bytemuck::bytes_of(&v));
    }

    /// The next pass's load: the clear for the frame's first pass, then `Load`.
    fn load_op(f: &mut Frame) -> wgpu::LoadOp<wgpu::Color> {
        let c = f.list.clear.to_f32().map(f64::from);
        let load = if f.first {
            wgpu::LoadOp::Clear(wgpu::Color {
                r: c[0],
                g: c[1],
                b: c[2],
                a: c[3],
            })
        } else {
            wgpu::LoadOp::Load
        };
        f.first = false;
        load
    }

    /// A render pass onto the pass's target: the frame (cleared by its first pass) or the dim
    /// layer (cleared to transparent by its first pass); the plot scissor under a manual axis.
    pub(super) fn begin_pass<'e>(
        enc: &'e mut wgpu::CommandEncoder,
        f: &mut Frame,
    ) -> wgpu::RenderPass<'e> {
        let to_dim = f.target == Target::Dim && f.dim.is_some();
        let load = if !to_dim {
            Self::load_op(f)
        } else if std::mem::replace(&mut f.dim_first, false) {
            wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
        } else {
            wgpu::LoadOp::Load
        };
        let view = match (to_dim, f.dim.as_ref()) {
            (true, Some(dim)) => dim,
            _ => &f.view,
        };
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("line"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load,
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        if let Some(clip) = f.list.clip {
            let (x, y, w, h) = scissor(clip, f.list.dpr, f.size);
            pass.set_scissor_rect(x, y, w, h);
        }
        pass
    }

    /// One render pass drawing `draw` from the instance buffer.
    pub(super) fn draw_pass(
        &mut self,
        ctx: &GpuContext,
        enc: &mut wgpu::CommandEncoder,
        f: &mut Frame,
        draw: Draw,
    ) {
        self.draw_pass_on(ctx, enc, f, draw, None);
    }

    pub(super) fn draw_pass_on(
        &mut self,
        ctx: &GpuContext,
        enc: &mut wgpu::CommandEncoder,
        f: &mut Frame,
        draw: Draw,
        status: Option<&wgpu::Buffer>,
    ) {
        let view_bg = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("view"),
            layout: &self.p.view_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: self.view_buf.as_entire_binding(),
            }],
        });
        let empty_clip = f.list.clip.is_some_and(|c| {
            let (_, _, w, h) = scissor(c, f.list.dpr, f.size);
            w == 0 || h == 0
        });
        let mut pass = Self::begin_pass(enc, f);
        if empty_clip || matches!(draw, Draw::Direct(0)) {
            return;
        }
        pass.set_pipeline(if f.target == Target::Dim {
            &self.p.line_dim
        } else {
            &self.p.line
        });
        pass.set_bind_group(0, &view_bg, &[]);
        pass.set_vertex_buffer(0, self.instances.buf.slice(..));
        match draw {
            Draw::Direct(count) => pass.draw(0..6, 0..count),
            Draw::Indirect => {
                if let Some(status) = status {
                    pass.draw_indirect(status, 0);
                }
            }
        }
        drop(pass);
        self.draws += 1;
    }

    /// Grows the instance buffer to the next power of two ≥ `all` (at least 2^20), capped at
    /// `max_instances`; never shrunk.
    pub(super) fn size_instances(&mut self, ctx: &GpuContext, all: u64) {
        let cap = all
            .next_power_of_two()
            .max(MIN_INSTANCES)
            .min(self.max_instances(ctx));
        self.instances
            .ensure(ctx, cap * INSTANCE_BYTES, &mut self.counters);
    }

    /// Instances the instance buffer holds now (≤ `max_instances`).
    pub(super) fn capacity(&self, ctx: &GpuContext) -> u64 {
        (self.instances.buf.size() / INSTANCE_BYTES).min(self.max_instances(ctx))
    }

    /// Windows [b·max, (b+1)·max) of `all` instances, in index order (§4.2).
    pub(super) fn batches(&self, ctx: &GpuContext, all: u64) -> Vec<(u64, u64)> {
        let max = self.max_instances(ctx);
        (0..all.div_ceil(max).max(1))
            .map(|b| (b * max, ((b + 1) * max).min(all)))
            .collect()
    }

    /// Draws a prepared instance list in batches (guides alone, or the raw-point test hook).
    fn draw_list(&mut self, ctx: &GpuContext, f: &mut Frame, all: &[LineInstance]) -> bool {
        let n = all.len() as u64;
        self.size_instances(ctx, n);
        for (lo, hi) in self.batches(ctx, n) {
            let part = &all[lo as usize..hi as usize];
            ctx.queue
                .write_buffer(&self.instances.buf, 0, bytemuck::cast_slice(part));
            let mut enc = ctx.device.create_command_encoder(&Default::default());
            self.draw_pass(ctx, &mut enc, f, Draw::Direct(part.len() as u32));
            ctx.queue.submit([enc.finish()]);
        }
        true
    }

    /// The column ranges of `line`, cached by (chunk, series, window, columns, DPR) (A.15.1).
    pub(super) fn ranges_for(&mut self, line: &LineRef, dpr: f32) -> RangesKey {
        let key = RangesKey {
            chunk: line.chunk.id,
            series: (line.series.start, line.series.end),
            window: (line.window.0.to_bits(), line.window.1.to_bits()),
            n: line.n,
            dpr: dpr.to_bits(),
        };
        if self.ranges_cache.as_ref().is_none_or(|c| c.key != key) {
            let (from, to) = line.window;
            let ranges = column_ranges(line.chunk, line.series.clone(), from, to, line.n);
            self.counters.ranges_builds += 1;
            self.ranges_cache = Some(RangesCache {
                key,
                ranges,
                uploaded: None,
            });
        }
        key
    }

    fn resident_slot(&mut self, chunk: &Chunk, enc: Encoding) -> usize {
        match self
            .resident
            .iter()
            .position(|r| r.chunk == chunk.id && r.enc == enc)
        {
            Some(i) => i,
            None => {
                let len = chunk.values.len() as u64;
                self.resident.push(Resident {
                    chunk: chunk.id,
                    enc,
                    len,
                    gpu: None,
                    cpu: None,
                });
                self.resident.len() - 1
            }
        }
    }

    /// The GPU values buffer of (chunk, encoding), encoded through the 16 MiB slab (L2).
    /// Stops at the first failed wait: the incomplete buffer is dropped, never cached, and the
    /// error ends the frame.
    pub(super) fn resident_gpu(
        &mut self,
        ctx: &GpuContext,
        chunk: &Chunk,
        enc: Encoding,
    ) -> Result<usize, dash_gpu::GpuError> {
        let i = self.resident_slot(chunk, enc);
        if self.resident[i].gpu.is_none() {
            let usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
            let bytes = 4 * chunk.values.len() as u64;
            let buf = create(ctx, "values", usage, bytes, &mut self.counters);
            self.staging.reserve(STAGING_WORDS.min(chunk.values.len()));
            // Queued uploads stay outstanding until a submission completes.
            let mut outstanding = 0u64;
            for (k, slice) in chunk.values.chunks(STAGING_WORDS).enumerate() {
                self.staging.clear();
                self.staging.extend(slice.iter().map(|v| enc.encode(*v)));
                let bytes: &[u8] = bytemuck::cast_slice(&self.staging);
                ctx.queue
                    .write_buffer(&buf, (k * STAGING_WORDS * 4) as u64, bytes);
                let max = &mut self.counters.staging_bytes_max;
                *max = (*max).max(bytes.len() as u64);
                outstanding += bytes.len() as u64;
                let peak = &mut self.counters.staging_outstanding_max;
                *peak = (*peak).max(outstanding);
                // L2: flush this slice and wait for it, so one slice is queued at a time
                // (Block). `Defer` never waits: `write_buffer` has copied the slice already.
                ctx.queue.submit([]);
                self.counters.value_slices_submitted += 1;
                if self.opts.sync == Sync::Defer {
                    outstanding = 0;
                    continue;
                }
                if let Err(e) = ctx.wait() {
                    if self.resident[i].cpu.is_none() {
                        self.resident.remove(i);
                    }
                    return Err(e);
                }
                outstanding = 0;
            }
            self.counters.value_encodes += 1;
            self.resident[i].gpu = Some(buf);
        }
        Ok(i)
    }

    /// The CPU slab of (chunk, encoding): the decimation input of the CPU path.
    fn resident_cpu(&mut self, chunk: &Chunk, enc: Encoding) -> usize {
        let i = self.resident_slot(chunk, enc);
        if self.resident[i].cpu.is_none() {
            self.resident[i].cpu = Some(chunk.values.iter().map(|v| enc.encode(*v)).collect());
            self.counters.value_encodes += 1;
        }
        i
    }

    fn draw_line(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        line: &LineRef,
        guides: &[LineInstance],
    ) -> bool {
        let key = self.ranges_for(line, f.list.dpr);
        match self.compute.take() {
            Some(mut c) if !line.far => {
                let ok = self.draw_line_gpu(ctx, f, line, guides, key, &mut c);
                self.compute = Some(c);
                ok
            }
            c => {
                self.compute = c;
                self.draw_line_cpu(ctx, f, line, guides)
            }
        }
    }

    /// T2 and far items: `dash-scales::decimate` per batch, then `write_buffer` and one draw.
    fn draw_line_cpu(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        line: &LineRef,
        guides: &[LineInstance],
    ) -> bool {
        let i = self.resident_cpu(line.chunk, line.encoding);
        // Taken out of `self` while the batches draw, and put back below.
        let (Some(bits), Some(cache)) = (self.resident[i].cpu.take(), self.ranges_cache.take())
        else {
            return false;
        };
        let ok = self.draw_cpu_batches(ctx, f, line, guides, &bits, &cache.ranges);
        self.resident[i].cpu = Some(bits);
        self.ranges_cache = Some(cache);
        ok
    }

    /// Test hook: the decimation buffers of the last Line item, read back (tier parity).
    pub fn read_decimation(&self, ctx: &GpuContext) -> Option<Decimated> {
        match self.last.as_ref()? {
            LastLine::Cpu(d) => Some(d.clone()),
            LastLine::Gpu {
                series,
                n,
                total,
                all,
            } => {
                let c = self.compute.as_ref()?;
                let read = |b: &wgpu::Buffer, bytes: u64| ctx.read_buffer(b, 0, bytes).ok();
                let cells = u64::from(*series) * u64::from(*n);
                let cols: Vec<ColOut> =
                    bytemuck::pod_collect_to_vec(&read(&c.cols.buf, COL_BYTES * cells)?);
                let counts: Vec<u32> =
                    bytemuck::pod_collect_to_vec(&read(&c.counts.buf, 4 * u64::from(*series))?);
                let starts: Vec<u32> =
                    bytemuck::pod_collect_to_vec(&read(&c.starts.buf, 4 * u64::from(*series))?);
                let shown = (*all).min(self.instances.buf.size() / INSTANCE_BYTES);
                let inst = read(&self.instances.buf, INSTANCE_BYTES * shown)?;
                let instances: Vec<LineInstance> = bytemuck::pod_collect_to_vec(&inst);
                Some(Decimated {
                    cols,
                    counts,
                    starts,
                    total: *total,
                    instances,
                })
            }
        }
    }

    /// Test hook: the column ranges of the last Line item (read back from the GPU on T1).
    pub fn debug_ranges(&self, ctx: &GpuContext) -> Option<ColumnRanges> {
        let cache = self.ranges_cache.as_ref()?;
        let Some(LastLine::Gpu { .. }) = self.last else {
            return Some(cache.ranges.clone());
        };
        let words = cache.ranges.words().len() as u64;
        let c = self.compute.as_ref()?;
        let bytes = ctx.read_buffer(&c.ranges.buf, 0, 4 * words).ok()?;
        let table: Vec<u32> = bytemuck::pod_collect_to_vec(&bytes);
        Some(match cache.ranges {
            ColumnRanges::Grid(_) => ColumnRanges::Grid(table),
            ColumnRanges::PerSeries { n, .. } => ColumnRanges::PerSeries { n, table },
        })
    }

    /// The decimated instance total of the last line item (guides excluded), once known: read
    /// back on T1 (`Block` at once, `Defer` after `poll`), computed on the CPU path.
    pub fn last_total(&self) -> Option<u64> {
        self.total
    }

    /// Draw calls issued by the last render (1 unless batched, §4.2).
    pub fn last_draws(&self) -> u32 {
        self.draws
    }

    /// Test hook: the GPU error that ended the last render early (the frame was not drawn).
    pub fn last_error(&self) -> Option<&dash_gpu::GpuError> {
        self.error.as_ref()
    }

    pub fn debug_counters(&self) -> DebugCounters {
        self.counters
    }

    /// Resident encoded-value buffers (GPU on T1, CPU on T2): (chunk, encoding, bytes).
    pub fn debug_resident(&self) -> Vec<(ChunkId, Encoding, u64)> {
        self.resident
            .iter()
            .map(|r| {
                let copies = u64::from(r.gpu.is_some()) + u64::from(r.cpu.is_some());
                (r.chunk, r.enc, 4 * r.len * copies)
            })
            .collect()
    }

    /// The target format the pipeline was built for.
    pub fn format(&self) -> wgpu::TextureFormat {
        self.format
    }
}
