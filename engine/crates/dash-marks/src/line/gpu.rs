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

use dash_gpu::{FrameTarget, GpuContext, Tier};
use dash_scales::decimate::{
    ColOut, DecimateInput, Decimated, FarClip, INST_KIND_SHIFT, INST_LANE_SHIFT, INST_SLOT,
    KIND_HLINE, LineInstance, decimate,
};
use dash_scales::encode::Encoding;
use dash_scales::{ColumnRanges, column_ranges};
use dash_wire::{Chunk, ChunkId};

use super::pipeline::{Pipelines, pipelines};
use crate::desc::{DrawList, DrawnEvent, MarkItem};

/// The L2 staging slab: 16 MiB of encoded values.
const STAGING_WORDS: usize = (16 << 20) / 4;
/// The instance buffer starts at 2^20 instances (capped at `max_instances`).
const MIN_INSTANCES: u64 = 1 << 20;
/// u32 words of `status` before the per-series base metas: draw-indirect args, total, padding.
const STATUS_HEADER: u64 = 8;
pub(super) const INSTANCE_BYTES: u64 = 16;
const COL_BYTES: u64 = 40;
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
struct PassU {
    n: u32,
    series: u32,
    per_series_ranges: u32,
    guides: u32,
    window_lo: u32,
    window_hi: u32,
    pad: [u32; 2],
}

/// The draw uniform (`line.wgsl` `View`, 256 bytes).
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
    colours: [[f32; 4]; 9],
}

/// A buffer that grows on demand and is never shrunk (L3).
#[derive(Debug)]
struct Grow {
    label: &'static str,
    usage: wgpu::BufferUsages,
    buf: wgpu::Buffer,
}

impl Grow {
    fn new(ctx: &GpuContext, label: &'static str, usage: wgpu::BufferUsages, size: u64) -> Self {
        let buf = create(ctx, label, usage, size);
        Self { label, usage, buf }
    }

    /// Reallocates when `size` exceeds the current size.
    fn ensure(&mut self, ctx: &GpuContext, size: u64) {
        if size > self.buf.size() {
            self.buf = create(ctx, self.label, self.usage, size);
        }
    }
}

fn create(ctx: &GpuContext, label: &str, usage: wgpu::BufferUsages, size: u64) -> wgpu::Buffer {
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
struct Resident {
    chunk: ChunkId,
    enc: Encoding,
    len: u64,
    gpu: Option<wgpu::Buffer>,
    cpu: Option<Vec<u32>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RangesKey {
    chunk: ChunkId,
    series: (u32, u32),
    window: (u64, u64),
    n: u32,
    dpr: u32,
}

#[derive(Debug)]
struct RangesCache {
    key: RangesKey,
    ranges: ColumnRanges,
    /// The key whose table is in the GPU ranges buffer.
    uploaded: Option<RangesKey>,
}

/// What `read_decimation` reads back.
#[derive(Debug)]
enum LastLine {
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
enum Draw {
    Direct(u32),
    /// `status[0..4]`, written by P3 (one batch only).
    Indirect,
}

/// Where a frame goes: its view, device size and whether the next pass clears.
struct Frame<'a> {
    list: &'a DrawList,
    view: wgpu::TextureView,
    size: (u32, u32),
    first: bool,
}

/// The line renderer. One per device; it owns the pipelines, the per-item buffers and the
/// resident encoded values.
#[derive(Debug)]
pub struct Renderer {
    format: wgpu::TextureFormat,
    opts: RendererOptions,
    p: Pipelines,
    pass_buf: wgpu::Buffer,
    view_buf: wgpu::Buffer,
    offsets: Grow,
    ranges: Grow,
    cols: Grow,
    counts: Grow,
    starts: Grow,
    status: Grow,
    instances: Grow,
    resident: Vec<Resident>,
    staging: Vec<u32>,
    ranges_cache: Option<RangesCache>,
    counters: DebugCounters,
    draws: u32,
    last: Option<LastLine>,
    /// The GPU error that ended the last render early, if any.
    error: Option<dash_gpu::GpuError>,
}

/// The fields of a `MarkItem::Line`.
struct LineRef<'a> {
    chunk: &'a std::sync::Arc<Chunk>,
    series: &'a std::ops::Range<u32>,
    window: (f64, f64),
    n: u32,
    plot: [f32; 4],
    encoding: Encoding,
    axis: (f32, f32),
    colour_slots: &'a [u8],
    lanes: Option<&'a [u16]>,
    width_css: f32,
    far: bool,
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
            }),
            MarkItem::Guides { .. } => None,
        }
    }

    fn series_count(&self) -> u32 {
        self.series.end.saturating_sub(self.series.start)
    }

    /// slot | lane << 16 per series.
    fn slot_lanes(&self) -> Vec<u32> {
        (0..self.series_count() as usize)
            .map(|s| {
                let slot = u32::from(self.colour_slots.get(s).copied().unwrap_or(0)) & INST_SLOT;
                let lane = u32::from(self.lanes.and_then(|l| l.get(s)).copied().unwrap_or(0));
                slot | (lane << INST_LANE_SHIFT)
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
        let storage = U::STORAGE | U::COPY_DST | U::COPY_SRC;
        let cap = MIN_INSTANCES.min(opts.max_instances.unwrap_or(ctx.max_instances).max(1));
        let uniform = U::UNIFORM | U::COPY_DST;
        Self {
            format,
            opts,
            p: pipelines(ctx, format),
            pass_buf: create(ctx, "pass", uniform, std::mem::size_of::<PassU>() as u64),
            view_buf: create(ctx, "view", uniform, std::mem::size_of::<ViewU>() as u64),
            offsets: Grow::new(ctx, "offsets", storage, 16),
            ranges: Grow::new(ctx, "ranges", storage, 16),
            cols: Grow::new(ctx, "cols", storage, COL_BYTES),
            counts: Grow::new(ctx, "counts", storage, 16),
            starts: Grow::new(ctx, "starts", storage, 16),
            status: Grow::new(ctx, "status", storage | U::INDIRECT, STATUS_HEADER * 4),
            instances: Grow::new(ctx, "instances", storage | U::VERTEX, cap * INSTANCE_BYTES),
            resident: Vec::new(),
            staging: Vec::new(),
            ranges_cache: None,
            counters: DebugCounters::default(),
            draws: 0,
            last: None,
            error: None,
        }
    }

    fn max_instances(&self, ctx: &GpuContext) -> u64 {
        self.opts.max_instances.unwrap_or(ctx.max_instances).max(1)
    }

    /// L1, L4: release every resident encoding no Line item of `list` draws from.
    fn release_unreferenced(&mut self, list: &DrawList) {
        self.resident.retain(|r| {
            list.items.iter().any(|i| match i {
                MarkItem::Line {
                    chunk, encoding, ..
                } => chunk.id == r.chunk && *encoding == r.enc,
                MarkItem::Guides { .. } => false,
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
        let size = target.size_px();
        if size.0 == 0 || size.1 == 0 || !(list.css.0 > 0.0 && list.css.1 > 0.0) {
            return None;
        }
        let mut f = Frame {
            list,
            view: target.view(),
            size,
            first: true,
        };
        let complete = self.draw(ctx, &mut f, None);
        (complete && !list.items.is_empty()).then_some(DrawnEvent {
            css_width: list.css.0,
            css_height: list.css.1,
            dpr: f64::from(list.dpr),
        })
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
        let size = target.size_px();
        if size.0 > 0 && size.1 > 0 {
            let mut f = Frame {
                list,
                view: target.view(),
                size,
                first: true,
            };
            let _ = self.draw(ctx, &mut f, Some(instances));
        }
    }

    fn draw(&mut self, ctx: &GpuContext, f: &mut Frame, replace: Option<&[LineInstance]>) -> bool {
        let mut complete = true;
        let mut guides: Vec<LineInstance> = Vec::new();
        let mut guides_plot = [0.0f32; 4];
        for item in &f.list.items {
            if let MarkItem::Guides { lines, plot } = item {
                guides.extend(guide_instances(lines));
                guides_plot = *plot;
                continue;
            }
            let Some(line) = LineRef::of(item) else {
                continue;
            };
            let g = std::mem::take(&mut guides);
            self.write_view(ctx, f, line.plot, line.axis, line.width_css);
            complete &= match replace {
                Some(raw) => {
                    let mut all = g;
                    all.extend_from_slice(raw);
                    self.draw_list(ctx, f, &all)
                }
                None => self.draw_line(ctx, f, &line, &g),
            };
        }
        if !guides.is_empty() {
            self.write_view(ctx, f, guides_plot, (0.0, 0.0), 0.0);
            complete &= self.draw_list(ctx, f, &guides);
        }
        if f.first {
            let mut enc = ctx.device.create_command_encoder(&Default::default());
            drop(Self::begin_pass(&mut enc, f));
            ctx.queue.submit([enc.finish()]);
        }
        complete
    }

    fn write_view(&self, ctx: &GpuContext, f: &Frame, plot: [f32; 4], axis: (f32, f32), w: f32) {
        let v = ViewU {
            view_proj: f.list.view_proj,
            device_px: [f.size.0 as f32, f.size.1 as f32],
            dpr: f.list.dpr,
            width_css: w,
            plot,
            ku: axis.0,
            ou: axis.1,
            lane_z0: 0.0,
            lane_dz: 0.0,
            colours: f.list.palette.map(|c| c.to_f32()),
        };
        ctx.queue
            .write_buffer(&self.view_buf, 0, bytemuck::bytes_of(&v));
    }

    fn begin_pass<'e>(enc: &'e mut wgpu::CommandEncoder, f: &mut Frame) -> wgpu::RenderPass<'e> {
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
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("line"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &f.view,
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
    fn draw_pass(
        &mut self,
        ctx: &GpuContext,
        enc: &mut wgpu::CommandEncoder,
        f: &mut Frame,
        draw: Draw,
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
        pass.set_pipeline(&self.p.line);
        pass.set_bind_group(0, &view_bg, &[]);
        pass.set_vertex_buffer(0, self.instances.buf.slice(..));
        match draw {
            Draw::Direct(count) => pass.draw(0..6, 0..count),
            Draw::Indirect => pass.draw_indirect(&self.status.buf, 0),
        }
        drop(pass);
        self.draws += 1;
    }

    /// Grows the instance buffer to the next power of two ≥ `all` (at least 2^20), capped at
    /// `max_instances`; never shrunk.
    fn size_instances(&mut self, ctx: &GpuContext, all: u64) {
        let cap = all
            .next_power_of_two()
            .max(MIN_INSTANCES)
            .min(self.max_instances(ctx));
        self.instances.ensure(ctx, cap * INSTANCE_BYTES);
    }

    /// Windows [b·max, (b+1)·max) of `all` instances, in index order (§4.2).
    fn batches(&self, ctx: &GpuContext, all: u64) -> Vec<(u64, u64)> {
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
    fn ranges_for(&mut self, line: &LineRef, dpr: f32) -> RangesKey {
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
    fn resident_gpu(
        &mut self,
        ctx: &GpuContext,
        chunk: &Chunk,
        enc: Encoding,
    ) -> Result<usize, dash_gpu::GpuError> {
        let i = self.resident_slot(chunk, enc);
        if self.resident[i].gpu.is_none() {
            let usage = wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST;
            let buf = create(ctx, "values", usage, 4 * chunk.values.len() as u64);
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
                // (native; Part C awaits the submission instead of blocking).
                ctx.queue.submit([]);
                self.counters.value_slices_submitted += 1;
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
        if ctx.tier == Tier::T2 || line.far {
            self.draw_line_cpu(ctx, f, line, guides)
        } else {
            self.draw_line_gpu(ctx, f, line, guides, key)
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

    /// Decimates, uploads, draws and releases one batch at a time (§4.2), so at most one bounded
    /// batch of instances is held and queued; batch 0 also yields `total` and is kept (without
    /// its instances when there are more batches) for `read_decimation`.
    fn draw_cpu_batches(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        line: &LineRef,
        guides: &[LineInstance],
        bits: &[u32],
        ranges: &ColumnRanges,
    ) -> bool {
        let offsets = &line.chunk.offsets[line.series.start as usize..=line.series.end as usize];
        let lanes: Vec<u16> = match line.lanes {
            Some(l) => l.to_vec(),
            None => vec![0; line.series_count() as usize],
        };
        let far = line.far.then(|| FarClip {
            values: &line.chunk.values,
            clip: line.encoding.clip_box(),
        });
        let g = guides.len() as u64;
        let max = self.max_instances(ctx);
        let run = |window: std::ops::Range<u64>| {
            decimate(&DecimateInput {
                values_bits: bits,
                offsets,
                ranges,
                n: line.n,
                guides: g as u32,
                colour_slots: line.colour_slots,
                lanes: &lanes,
                window,
                far,
            })
        };
        let mut first = Some(run(0..max));
        let all = g + first.as_ref().map_or(0, |d| d.total);
        self.size_instances(ctx, all);
        let batches = self.batches(ctx, all);
        let single = batches.len() == 1;
        for (lo, hi) in batches {
            let mut d = match first.take() {
                Some(d) => d,
                None => run(lo..hi),
            };
            let held = INSTANCE_BYTES * d.instances.len() as u64;
            let peak = &mut self.counters.cpu_instance_bytes_peak;
            *peak = (*peak).max(held);
            for (k, gi) in guides.iter().enumerate().skip(lo as usize) {
                if let Some(slot) = d.instances.get_mut(k - lo as usize) {
                    *slot = *gi;
                }
            }
            ctx.queue
                .write_buffer(&self.instances.buf, 0, bytemuck::cast_slice(&d.instances));
            let mut enc = ctx.device.create_command_encoder(&Default::default());
            self.draw_pass(ctx, &mut enc, f, Draw::Direct(d.instances.len() as u32));
            ctx.queue.submit([enc.finish()]);
            if !single && let Err(e) = ctx.wait() {
                self.error = Some(e);
                return false;
            }
            if lo == 0 {
                if !single {
                    d.instances = Vec::new();
                }
                self.last = Some(LastLine::Cpu(d));
            }
        }
        true
    }

    /// T1: P1 → P2 → P3, read `total`, size or batch, then P4 → P5 → draw per batch.
    fn draw_line_gpu(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        line: &LineRef,
        guides: &[LineInstance],
        key: RangesKey,
    ) -> bool {
        let (series, n) = (line.series_count(), line.n);
        let vi = match self.resident_gpu(ctx, line.chunk, line.encoding) {
            Ok(vi) => vi,
            Err(e) => {
                self.error = Some(e);
                return false;
            }
        };
        // The item's series offsets, the ranges table (unless already uploaded) and the
        // per-series slot and lane after the status header.
        let offsets = &line.chunk.offsets[line.series.start as usize..=line.series.end as usize];
        self.offsets.ensure(ctx, 4 * offsets.len() as u64);
        ctx.queue
            .write_buffer(&self.offsets.buf, 0, bytemuck::cast_slice(offsets));
        let Some(cache) = self.ranges_cache.as_mut() else {
            return false;
        };
        let words = cache.ranges.words();
        if cache.uploaded != Some(key) {
            self.ranges.ensure(ctx, 4 * words.len() as u64);
            ctx.queue
                .write_buffer(&self.ranges.buf, 0, bytemuck::cast_slice(words));
            cache.uploaded = Some(key);
        }
        let per_series = matches!(cache.ranges, ColumnRanges::PerSeries { .. });
        self.cols
            .ensure(ctx, COL_BYTES * u64::from(series) * u64::from(n));
        self.counts.ensure(ctx, 4 * u64::from(series));
        self.starts.ensure(ctx, 4 * u64::from(series));
        self.status
            .ensure(ctx, 4 * (STATUS_HEADER + u64::from(series)));
        let slot_lanes = line.slot_lanes();
        ctx.queue.write_buffer(
            &self.status.buf,
            4 * STATUS_HEADER,
            bytemuck::cast_slice(&slot_lanes),
        );
        let g = guides.len() as u32;
        let mut pass_u = PassU {
            n,
            series,
            per_series_ranges: u32::from(per_series),
            guides: g,
            window_lo: 0,
            window_hi: u32::MAX,
            pad: [0; 2],
        };
        ctx.queue
            .write_buffer(&self.pass_buf, 0, bytemuck::bytes_of(&pass_u));
        let pass_bg = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pass"),
            layout: &self.p.pass_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: self.pass_buf.as_entire_binding(),
            }],
        });
        // P1–P3, then the blocking read of `total` (Part C re-runs an under-sized frame instead).
        let Some(data_bg) = self.data_bind_group(ctx, vi) else {
            return false;
        };
        let mut enc = ctx.device.create_command_encoder(&Default::default());
        {
            let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("P1-P3"),
                timestamp_writes: None,
            });
            cp.set_bind_group(0, &pass_bg, &[]);
            cp.set_bind_group(1, &data_bg, &[]);
            cp.set_pipeline(&self.p.reduce);
            cp.dispatch_workgroups(n.div_ceil(64), series, 1);
            cp.set_pipeline(&self.p.count);
            cp.dispatch_workgroups(series.div_ceil(64), 1, 1);
            cp.set_pipeline(&self.p.scan);
            cp.dispatch_workgroups(1, 1, 1);
        }
        ctx.queue.submit([enc.finish()]);
        let header = match ctx.read_buffer(&self.status.buf, 0, 4 * STATUS_HEADER) {
            Ok(h) => h,
            Err(e) => {
                self.error = Some(e);
                return false;
            }
        };
        let total = u64::from(bytemuck::pod_read_unaligned::<u32>(&header[16..20]));
        let all = u64::from(g) + total;
        // Size (one draw) or batch; a reallocated instance buffer needs a new bind group.
        self.size_instances(ctx, all);
        let Some(data_bg) = self.data_bind_group(ctx, vi) else {
            return false;
        };
        let batches = self.batches(ctx, all);
        let single = batches.len() == 1;
        for (lo, hi) in batches {
            let take = hi.saturating_sub(lo) as usize;
            let gs: Vec<LineInstance> = guides
                .iter()
                .copied()
                .skip(lo as usize)
                .take(take)
                .collect();
            if !gs.is_empty() {
                ctx.queue
                    .write_buffer(&self.instances.buf, 0, bytemuck::cast_slice(&gs));
            }
            (pass_u.window_lo, pass_u.window_hi) = (lo as u32, hi as u32);
            ctx.queue
                .write_buffer(&self.pass_buf, 0, bytemuck::bytes_of(&pass_u));
            let mut enc = ctx.device.create_command_encoder(&Default::default());
            {
                let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("P4-P5"),
                    timestamp_writes: None,
                });
                cp.set_bind_group(0, &pass_bg, &[]);
                cp.set_bind_group(1, &data_bg, &[]);
                cp.set_pipeline(&self.p.emit);
                cp.dispatch_workgroups(series.div_ceil(64), 1, 1);
                cp.set_pipeline(&self.p.spill);
                cp.dispatch_workgroups(n.div_ceil(64), series, 1);
            }
            let draw = if single {
                Draw::Indirect
            } else {
                Draw::Direct((hi - lo) as u32)
            };
            self.draw_pass(ctx, &mut enc, f, draw);
            ctx.queue.submit([enc.finish()]);
        }
        self.last = Some(LastLine::Gpu {
            series,
            n,
            total,
            all,
        });
        true
    }

    fn data_bind_group(&self, ctx: &GpuContext, values: usize) -> Option<wgpu::BindGroup> {
        let values = self.resident.get(values)?.gpu.as_ref()?;
        let bufs = [
            values,
            &self.offsets.buf,
            &self.ranges.buf,
            &self.cols.buf,
            &self.counts.buf,
            &self.starts.buf,
            &self.instances.buf,
            &self.status.buf,
        ];
        let entries: Vec<wgpu::BindGroupEntry> = bufs
            .iter()
            .enumerate()
            .map(|(i, b)| wgpu::BindGroupEntry {
                binding: i as u32,
                resource: b.as_entire_binding(),
            })
            .collect();
        Some(ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("data"),
            layout: &self.p.data_bgl,
            entries: &entries,
        }))
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
                let read = |b: &wgpu::Buffer, bytes: u64| ctx.read_buffer(b, 0, bytes).ok();
                let cells = u64::from(*series) * u64::from(*n);
                let cols: Vec<ColOut> =
                    bytemuck::pod_collect_to_vec(&read(&self.cols.buf, COL_BYTES * cells)?);
                let counts: Vec<u32> =
                    bytemuck::pod_collect_to_vec(&read(&self.counts.buf, 4 * u64::from(*series))?);
                let starts: Vec<u32> =
                    bytemuck::pod_collect_to_vec(&read(&self.starts.buf, 4 * u64::from(*series))?);
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
        let bytes = ctx.read_buffer(&self.ranges.buf, 0, 4 * words).ok()?;
        let table: Vec<u32> = bytemuck::pod_collect_to_vec(&bytes);
        Some(match cache.ranges {
            ColumnRanges::Grid(_) => ColumnRanges::Grid(table),
            ColumnRanges::PerSeries { n, .. } => ColumnRanges::PerSeries { n, table },
        })
    }

    /// `Sync::Defer`: the state of the last frame's status read-back.
    pub fn poll(&mut self) -> Pending {
        Pending::Idle
    }

    /// The decimated instance total of the last line item (guides excluded), once known.
    pub fn last_total(&self) -> Option<u64> {
        None
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
