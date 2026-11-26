//! The selection's line passes (plan #68 C2c2 §3.3; ADR-0025 decision 4, ADR-0032).
//!
//! A Line item with an emphasis is decimated once and its instances drawn in 3 + 2m passes, each
//! with its own view uniform and submission:
//!
//! | Pass | Draws | Onto |
//! |---|---|---|
//! | A1 | the guides | the frame |
//! | A2 | lane 0 (the unmatched series), at their colours and full alpha | the dim layer, cleared to transparent |
//! | A3 | the dim layer, once, at `dimmed` | the frame |
//! | B_r | lane r (the r-th matched series in shown order), 4 px wider, `focus` | the frame |
//! | C_r | lane r, at its colour | the frame |
//!
//! Lanes come from the emphasis: a matched series' lane is its rank r (1…m), every other series'
//! lane 0. With one instance batch every pass reuses the decimated instances (T1: the same
//! indirect args; the CPU path: the same buffer); with more, passes are outer and batches inner,
//! so the decimation repeats per pass. Without an emphasis there is one pass (`All`): the draw of
//! C2c1.
//!
//! The dim layer is one `Rgba8Unorm` texture per renderer at the target's device size: made on
//! the first emphasis draw, made again on a resize and released on a list without an emphasis
//! (and with the renderer, as after a device loss). A2 draws into it premultiplied, so coverage a
//! of colour c composites as `dst·(1 − a·d) + c·a·d`: overlapping capsules and crossing series add
//! up in the layer as on the frame, and are dimmed once.

use dash_gpu::GpuContext;
use dash_scales::ColumnRanges;
use dash_scales::decimate::{DecimateInput, FarClip, LineInstance, decimate};

use super::gpu::{Draw, Frame, INSTANCE_BYTES, LastLine, LineRef, Renderer, Sync};
use super::pipeline::DIM_FORMAT;
use crate::desc::{DrawList, MarkItem};

/// `lane_only`: every lane (no emphasis).
pub(super) const ALL_LANES: u32 = u32::MAX;
/// `lane_only`: no series lane (A1, the guides only).
pub(super) const NO_LANE: u32 = u32::MAX - 1;

/// One pass of a Line item, as the test hook logs it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PassKind {
    /// No emphasis: every lane and the guides, at the series' colours.
    All,
    /// The guides only, onto the frame.
    A1,
    /// Lane 0 (the unmatched series) into the dim layer.
    A2,
    /// The dim layer composited onto the frame at `dimmed`.
    A3,
    /// The r-th matched series' `focus` underlay.
    B(u32),
    /// The r-th matched series' line.
    C(u32),
}

/// Where a pass draws.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Target {
    #[default]
    Frame,
    Dim,
}

/// One pass: what the view uniform selects, and where it draws.
#[derive(Clone, Copy, Debug)]
pub(super) struct Pass {
    pub(super) kind: PassKind,
    pub(super) lane_only: u32,
    pub(super) guides: bool,
    /// Kinds 0–2 in this colour instead of their series' (the underlay).
    pub(super) colour: Option<[f32; 4]>,
    pub(super) width_css: f32,
    pub(super) target: Target,
    /// A3: the composite's opacity.
    pub(super) dimmed: f32,
}

impl Pass {
    /// The single pass of a list without an emphasis: every lane and the guides.
    pub(super) fn all(width_css: f32) -> Self {
        Self {
            kind: PassKind::All,
            lane_only: ALL_LANES,
            guides: true,
            colour: None,
            width_css,
            target: Target::Frame,
            dimmed: 1.0,
        }
    }
}

/// The passes of `line` (§3.3): one without an emphasis (or with no series matched), else A1, A2,
/// A3, then B_r and C_r for each matched series in shown order.
pub(super) fn plan(line: &LineRef) -> Vec<Pass> {
    let w = line.width_css;
    let Some(e) = line.emphasis.filter(|e| e.matched.iter().any(|m| *m)) else {
        return vec![Pass::all(w)];
    };
    let m = e.matched.iter().filter(|m| **m).count() as u32;
    let lines = |kind, lane_only, guides, target| Pass {
        kind,
        lane_only,
        guides,
        colour: None,
        width_css: w,
        target,
        dimmed: 1.0,
    };
    let mut out = vec![
        lines(PassKind::A1, NO_LANE, true, Target::Frame),
        lines(PassKind::A2, 0, false, Target::Dim),
        Pass {
            dimmed: e.dimmed,
            ..lines(PassKind::A3, NO_LANE, false, Target::Frame)
        },
    ];
    for r in 1..=m {
        out.push(Pass {
            colour: Some(e.focus.to_f32()),
            width_css: w + e.underlay_extra_css,
            ..lines(PassKind::B(r), r, false, Target::Frame)
        });
        out.push(lines(PassKind::C(r), r, false, Target::Frame));
    }
    out
}

/// The per-series lanes of `line`: the matched rank (1…m) under an emphasis, else the item's
/// `lanes` (None: 0 for all).
pub(super) fn lanes_of(line: &LineRef) -> Vec<u16> {
    let n = line.series_count() as usize;
    if let Some(e) = line.emphasis {
        let mut r = 0u16;
        return (0..n)
            .map(|s| {
                if e.matched.get(s).copied().unwrap_or(false) {
                    r = r.saturating_add(1);
                    r
                } else {
                    0
                }
            })
            .collect();
    }
    (0..n)
        .map(|s| line.lanes.and_then(|l| l.get(s)).copied().unwrap_or(0))
        .collect()
}

/// The dim layer: its texture's view and device size.
#[derive(Debug)]
pub(super) struct DimLayer {
    pub(super) view: wgpu::TextureView,
    size: (u32, u32),
}

/// The composite uniform (`dim.wgsl` `U`).
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct CompositeU {
    dimmed: f32,
    pad: [f32; 3],
}

/// The A3 pipeline (`dim.wgsl`) and its uniform.
#[derive(Debug)]
pub(super) struct Composite {
    bgl: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
    uniform: wgpu::Buffer,
}

impl Composite {
    pub(super) fn new(ctx: &GpuContext, format: wgpu::TextureFormat) -> Self {
        let d = &ctx.device;
        let m = d.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("dim.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("dim.wgsl").into()),
        });
        let bgl = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("dim"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: false },
                        view_dimension: wgpu::TextureViewDimension::D2,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: None,
                    },
                    count: None,
                },
            ],
        });
        let layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("dim"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let over = wgpu::BlendComponent {
            src_factor: wgpu::BlendFactor::One,
            dst_factor: wgpu::BlendFactor::OneMinusSrcAlpha,
            operation: wgpu::BlendOperation::Add,
        };
        let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("dim composite"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &m,
                entry_point: Some("vs"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &m,
                entry_point: Some("fs"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState {
                        color: over,
                        alpha: over,
                    }),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let uniform = d.create_buffer(&wgpu::BufferDescriptor {
            label: Some("dim"),
            size: std::mem::size_of::<CompositeU>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        Self {
            bgl,
            pipeline,
            uniform,
        }
    }
}

impl Renderer {
    /// Test hook: the passes of the last render's Line items, in order.
    pub fn last_passes(&self) -> Vec<PassKind> {
        self.passes.clone()
    }

    /// Test hook: the dim layer's device size, while it exists.
    pub fn dim_layer_size(&self) -> Option<(u32, u32)> {
        self.dim.as_ref().map(|d| d.size)
    }

    /// The dim layer for `list` at the target's `size`: kept, made (again at a new size), or
    /// released when no Line item of the list has an emphasis.
    pub(super) fn prepare_dim(&mut self, ctx: &GpuContext, list: &DrawList, size: (u32, u32)) {
        let wanted = list.items.iter().any(|i| {
            matches!(i, MarkItem::Line { emphasis: Some(e), .. } if e.matched.iter().any(|m| *m))
        });
        if !wanted {
            self.dim = None;
            return;
        }
        if self.dim.as_ref().is_some_and(|d| d.size == size) {
            return;
        }
        let texture = ctx.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("dim layer"),
            size: wgpu::Extent3d {
                width: size.0,
                height: size.1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: DIM_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&Default::default());
        self.dim = Some(DimLayer { view, size });
    }

    /// Runs one pass in its own submission: `pre` (compute work that must precede the draw in the
    /// same encoder: T1's P4–P5), then the pass (`encode_pass`).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn run_pass(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        line: &LineRef,
        p: &Pass,
        draw: Draw,
        status: Option<&wgpu::Buffer>,
        pre: impl FnOnce(&mut wgpu::CommandEncoder),
    ) {
        let mut enc = ctx.device.create_command_encoder(&Default::default());
        pre(&mut enc);
        self.encode_pass(ctx, &mut enc, f, line, p, draw, status);
        ctx.queue.submit([enc.finish()]);
    }

    /// Encodes pass `p`: its view written first, then its draw onto its target (A3: the
    /// composite); logged once per pass (not per batch).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn encode_pass(
        &mut self,
        ctx: &GpuContext,
        enc: &mut wgpu::CommandEncoder,
        f: &mut Frame,
        line: &LineRef,
        p: &Pass,
        draw: Draw,
        status: Option<&wgpu::Buffer>,
    ) {
        if self.passes.last() != Some(&p.kind) {
            self.passes.push(p.kind);
        }
        if p.kind == PassKind::A3 {
            self.composite(ctx, enc, f, p.dimmed);
            return;
        }
        self.write_view(ctx, f, line.plot, line.axis, p);
        f.target = p.target;
        self.draw_pass_on(ctx, enc, f, draw, status);
        f.target = Target::Frame;
    }

    /// A3: the dim layer onto the frame at `dimmed`, one full-target triangle.
    fn composite(
        &mut self,
        ctx: &GpuContext,
        enc: &mut wgpu::CommandEncoder,
        f: &mut Frame,
        dimmed: f32,
    ) {
        let Some(dim) = self.dim.as_ref() else {
            return;
        };
        let u = CompositeU {
            dimmed,
            pad: [0.0; 3],
        };
        ctx.queue
            .write_buffer(&self.composite.uniform, 0, bytemuck::bytes_of(&u));
        let bg = ctx.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("dim"),
            layout: &self.composite.bgl,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&dim.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: self.composite.uniform.as_entire_binding(),
                },
            ],
        });
        let mut pass = Self::begin_pass(enc, f);
        pass.set_pipeline(&self.composite.pipeline);
        pass.set_bind_group(0, &bg, &[]);
        pass.draw(0..3, 0..1);
    }

    /// T2 and far items: `dash-scales::decimate` per batch, then `write_buffer` and the passes.
    /// One batch: decimated once, every pass draws it. More: passes outer, batches inner (each
    /// decimated, uploaded, drawn and released in turn, §4.2), so at most one bounded batch of
    /// instances is held and queued; batch 0 of the first pass also yields `total` and is kept
    /// (without its instances when there are more batches) for `read_decimation`.
    pub(super) fn draw_cpu_batches(
        &mut self,
        ctx: &GpuContext,
        f: &mut Frame,
        line: &LineRef,
        guides: &[LineInstance],
        bits: &[u32],
        ranges: &ColumnRanges,
    ) -> bool {
        let offsets = &line.chunk.offsets[line.series.start as usize..=line.series.end as usize];
        let lanes = lanes_of(line);
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
        let passes = plan(line);
        let mut first = Some(run(0..max));
        let all = g + first.as_ref().map_or(0, |d| d.total);
        self.size_instances(ctx, all);
        let batches = self.batches(ctx, all);
        let single = batches.len() == 1;
        for (pi, p) in passes.iter().enumerate() {
            if p.kind == PassKind::A3 {
                self.run_pass(ctx, f, line, p, Draw::Direct(0), None, |_| {});
                continue;
            }
            for &(lo, hi) in &batches {
                if single && pi > 0 {
                    // One batch: the instances are in the buffer already.
                    let count = (hi - lo) as u32;
                    self.run_pass(ctx, f, line, p, Draw::Direct(count), None, |_| {});
                    continue;
                }
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
                let count = d.instances.len() as u32;
                self.run_pass(ctx, f, line, p, Draw::Direct(count), None, |_| {});
                if !single
                    && self.opts.sync == Sync::Block
                    && let Err(e) = ctx.wait()
                {
                    self.error = Some(e);
                    return false;
                }
                if pi == 0 && lo == 0 {
                    if !single {
                        d.instances = Vec::new();
                    }
                    self.total = Some(d.total);
                    self.last = Some(LastLine::Cpu(d));
                }
            }
        }
        true
    }
}
