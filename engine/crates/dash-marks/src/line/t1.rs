//! The T1 compute path (plan #68 §4.2, C1 §3.1): P1 → P2 → P3, the total (read back under
//! `Block`; known, or deferred to `poll`, under `Defer`), then P4 → P5 → draw per batch.

use dash_gpu::GpuContext;
use dash_scales::ColumnRanges;
use dash_scales::decimate::LineInstance;

use super::defer::{Readback, TotalKey};
use super::gpu::{
    COL_BYTES, DebugCounters, Draw, Frame, Grow, INSTANCE_BYTES, LastLine, LineRef, PassU,
    RangesKey, Renderer, STATUS_HEADER, Sync, create,
};
use super::pipeline::{ComputePipelines, compute_pipelines};

/// The status header's bytes (draw-indirect args, the total, padding).
const HEADER_BYTES: u64 = 4 * STATUS_HEADER;

/// The T1 compute resources: the P1–P5 pipelines, their uniform and storage buffers.
#[derive(Debug)]
pub(super) struct Compute {
    p: ComputePipelines,
    pass_buf: wgpu::Buffer,
    offsets: Grow,
    pub(super) ranges: Grow,
    pub(super) cols: Grow,
    pub(super) counts: Grow,
    pub(super) starts: Grow,
    pub(super) status: Grow,
}

impl Compute {
    pub(super) fn new(ctx: &GpuContext, counters: &mut DebugCounters) -> Self {
        use wgpu::BufferUsages as U;
        let storage = U::STORAGE | U::COPY_DST | U::COPY_SRC;
        let pass_bytes = std::mem::size_of::<PassU>() as u64;
        counters.compute_pipelines += ComputePipelines::COUNT;
        Self {
            p: compute_pipelines(ctx),
            pass_buf: create(ctx, "pass", U::UNIFORM | U::COPY_DST, pass_bytes, counters),
            offsets: Grow::new(ctx, "offsets", storage, 16, counters),
            ranges: Grow::new(ctx, "ranges", storage, 16, counters),
            cols: Grow::new(ctx, "cols", storage, COL_BYTES, counters),
            counts: Grow::new(ctx, "counts", storage, 16, counters),
            starts: Grow::new(ctx, "starts", storage, 16, counters),
            status: Grow::new(ctx, "status", storage | U::INDIRECT, HEADER_BYTES, counters),
        }
    }
}

impl Renderer {
    /// T1: P1–P3, the total, then P4–P5 and the draw per batch. Under `Defer` with an unknown
    /// total the item is drawn in one window `0..capacity` with an indirect draw, and the header
    /// is read back without waiting (`self.awaiting`).
    pub(super) fn draw_line_gpu(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        line: &LineRef,
        guides: &[LineInstance],
        key: RangesKey,
        c: &mut Compute,
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
        c.offsets
            .ensure(ctx, 4 * offsets.len() as u64, &mut self.counters);
        ctx.queue
            .write_buffer(&c.offsets.buf, 0, bytemuck::cast_slice(offsets));
        let Some(cache) = self.ranges_cache.as_mut() else {
            return false;
        };
        let words = cache.ranges.words();
        if cache.uploaded != Some(key) {
            c.ranges
                .ensure(ctx, 4 * words.len() as u64, &mut self.counters);
            ctx.queue
                .write_buffer(&c.ranges.buf, 0, bytemuck::cast_slice(words));
            cache.uploaded = Some(key);
        }
        let per_series = matches!(cache.ranges, ColumnRanges::PerSeries { .. });
        let cells = u64::from(series) * u64::from(n);
        c.cols.ensure(ctx, COL_BYTES * cells, &mut self.counters);
        c.counts
            .ensure(ctx, 4 * u64::from(series), &mut self.counters);
        c.starts
            .ensure(ctx, 4 * u64::from(series), &mut self.counters);
        c.status.ensure(
            ctx,
            4 * (STATUS_HEADER + u64::from(series)),
            &mut self.counters,
        );
        let slot_lanes = line.slot_lanes();
        ctx.queue.write_buffer(
            &c.status.buf,
            HEADER_BYTES,
            bytemuck::cast_slice(&slot_lanes),
        );
        let g = guides.len() as u32;
        let tkey = TotalKey {
            ranges: key,
            encoding: line.encoding,
            guides: g,
        };
        let known = self
            .known
            .filter(|(k, _)| *k == tkey)
            .map(|(_, total)| total);
        if self.opts.sync == Sync::Defer && known.is_none() {
            return self.draw_deferred(ctx, f, c, vi, guides, (series, n, per_series), tkey);
        }
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
            .write_buffer(&c.pass_buf, 0, bytemuck::bytes_of(&pass_u));
        let pass_bg = self.pass_bind_group(ctx, c);
        // P1–P3, then the total: read back (Block) or known (Defer).
        let Some(data_bg) = self.data_bind_group(ctx, c, vi) else {
            return false;
        };
        let mut enc = ctx.device.create_command_encoder(&Default::default());
        Self::p1_p3(&mut enc, c, &pass_bg, &data_bg, series, n);
        ctx.queue.submit([enc.finish()]);
        let total = match known {
            Some(t) => t,
            None => match ctx.read_buffer(&c.status.buf, 0, HEADER_BYTES) {
                Ok(h) => u64::from(bytemuck::pod_read_unaligned::<u32>(&h[16..20])),
                Err(e) => {
                    self.error = Some(e);
                    return false;
                }
            },
        };
        self.total = Some(total);
        let all = u64::from(g) + total;
        // Size (one draw) or batch; a reallocated instance buffer needs a new bind group.
        self.size_instances(ctx, all);
        let Some(data_bg) = self.data_bind_group(ctx, c, vi) else {
            return false;
        };
        let batches = self.batches(ctx, all);
        let single = batches.len() == 1;
        for (lo, hi) in batches {
            self.write_guides(ctx, guides, lo, hi);
            (pass_u.window_lo, pass_u.window_hi) = (lo as u32, hi as u32);
            ctx.queue
                .write_buffer(&c.pass_buf, 0, bytemuck::bytes_of(&pass_u));
            let mut enc = ctx.device.create_command_encoder(&Default::default());
            Self::p4_p5(&mut enc, c, &pass_bg, &data_bg, series, n);
            let draw = if single {
                Draw::Indirect
            } else {
                Draw::Direct((hi - lo) as u32)
            };
            self.draw_pass_with(ctx, &mut enc, f, draw, c);
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

    /// `Defer`, total unknown: one window `0..cap` through all five passes and an indirect draw
    /// (P3 caps the count at `cap`), then the header copied out and mapped.
    #[allow(clippy::too_many_arguments)]
    fn draw_deferred(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        c: &mut Compute,
        vi: usize,
        guides: &[LineInstance],
        (series, n, per_series): (u32, u32, bool),
        tkey: TotalKey,
    ) -> bool {
        let g = guides.len() as u64;
        let cap = self.capacity(ctx);
        let pass_u = PassU {
            n,
            series,
            per_series_ranges: u32::from(per_series),
            guides: g as u32,
            window_lo: 0,
            window_hi: u32::try_from(cap).unwrap_or(u32::MAX),
            pad: [0; 2],
        };
        ctx.queue
            .write_buffer(&c.pass_buf, 0, bytemuck::bytes_of(&pass_u));
        self.write_guides(ctx, guides, 0, cap);
        let pass_bg = self.pass_bind_group(ctx, c);
        let Some(data_bg) = self.data_bind_group(ctx, c, vi) else {
            return false;
        };
        let read = create(
            ctx,
            "status readback",
            wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            HEADER_BYTES,
            &mut self.counters,
        );
        let mut enc = ctx.device.create_command_encoder(&Default::default());
        Self::p1_p3(&mut enc, c, &pass_bg, &data_bg, series, n);
        Self::p4_p5(&mut enc, c, &pass_bg, &data_bg, series, n);
        self.draw_pass_with(ctx, &mut enc, f, Draw::Indirect, c);
        enc.copy_buffer_to_buffer(&c.status.buf, 0, &read, 0, HEADER_BYTES);
        ctx.queue.submit([enc.finish()]);
        self.pending = Some(Readback::start(read, tkey, g, cap, !ctx.take_map()));
        self.awaiting = true;
        self.last = Some(LastLine::Gpu {
            series,
            n,
            total: 0,
            all: g,
        });
        true
    }

    /// The guides of the batch window `lo..hi` at the start of the instance buffer.
    fn write_guides(&self, ctx: &GpuContext, guides: &[LineInstance], lo: u64, hi: u64) {
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
    }

    fn p1_p3(
        enc: &mut wgpu::CommandEncoder,
        c: &Compute,
        pass_bg: &wgpu::BindGroup,
        data_bg: &wgpu::BindGroup,
        series: u32,
        n: u32,
    ) {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("P1-P3"),
            timestamp_writes: None,
        });
        cp.set_bind_group(0, pass_bg, &[]);
        cp.set_bind_group(1, data_bg, &[]);
        cp.set_pipeline(&c.p.reduce);
        cp.dispatch_workgroups(n.div_ceil(64), series, 1);
        cp.set_pipeline(&c.p.count);
        cp.dispatch_workgroups(series.div_ceil(64), 1, 1);
        cp.set_pipeline(&c.p.scan);
        cp.dispatch_workgroups(1, 1, 1);
    }

    fn p4_p5(
        enc: &mut wgpu::CommandEncoder,
        c: &Compute,
        pass_bg: &wgpu::BindGroup,
        data_bg: &wgpu::BindGroup,
        series: u32,
        n: u32,
    ) {
        let mut cp = enc.begin_compute_pass(&wgpu::ComputePassDescriptor {
            label: Some("P4-P5"),
            timestamp_writes: None,
        });
        cp.set_bind_group(0, pass_bg, &[]);
        cp.set_bind_group(1, data_bg, &[]);
        cp.set_pipeline(&c.p.emit);
        cp.dispatch_workgroups(series.div_ceil(64), 1, 1);
        cp.set_pipeline(&c.p.spill);
        cp.dispatch_workgroups(n.div_ceil(64), series, 1);
    }

    fn pass_bind_group(&self, ctx: &GpuContext, c: &Compute) -> wgpu::BindGroup {
        ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("pass"),
            layout: &c.p.pass_bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: c.pass_buf.as_entire_binding(),
            }],
        })
    }

    fn data_bind_group(
        &self,
        ctx: &GpuContext,
        c: &Compute,
        values: usize,
    ) -> Option<wgpu::BindGroup> {
        let values = self.resident.get(values)?.gpu.as_ref()?;
        let bufs = [
            values,
            &c.offsets.buf,
            &c.ranges.buf,
            &c.cols.buf,
            &c.counts.buf,
            &c.starts.buf,
            &self.instances.buf,
            &c.status.buf,
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
            layout: &c.p.data_bgl,
            entries: &entries,
        }))
    }
}

/// Instance bytes, for the capacity arithmetic above.
const _: () = assert!(INSTANCE_BYTES == 16);
