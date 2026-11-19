//! The M1 line mark (plan #24 §3.5, §4.3, §4.4): value and pyramid textures, the GPU decimation
//! pass (T1 compute, T2 render-to-texture) and the column-coverage draw.
//!
//! | Texture | Format | Size | Bound in (group 0; `@0` = `LineUniforms`) |
//! |---|---|---|---|
//! | values | `R32Uint` 2D array | tex_w² × value_layers | decimate @1, draw @4 |
//! | pyramid | `Rgba32Uint` 2D array | tex_w² × pyr_layers | decimate @2 |
//! | bounds | `R32Uint` 2D | tile_w × ⌈(capacity + 1)/tile_w⌉ | decimate @3, draw @5 |
//! | rec_a, rec_b | `Rgba32Uint` 2D array | tile_w × S × tiles | decimate @4, @5 or targets; draw @1, @2 |
//! | rec_k | `R32Uint` 2D array | as rec_a | draw @3 |
//!
//! A single-layer value or pyramid texture is only as tall as its data needs (the addressing
//! is unchanged). On the Fragment path (T2, GL) every array texture has at least two layers: GL
//! creates a one-layer texture as `TEXTURE_2D`, which a 2D-array binding cannot sample. The T2
//! decimation reads its tile layer from a dynamic-offset uniform at `@6`.

use std::cell::Cell;

use dash_scales::Plot;
use dash_scales::lod::{Pyramid, SlotRecord, levels_for};
use dash_scene::line::{LayoutInfo, LineFrame, LineUniforms};

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

/// The widest value / pyramid texture.
const MAX_TEX_W: u32 = 4_096;
/// Pyramid levels the uniforms carry (n ≤ 10⁶).
const MAX_LEVELS: u32 = 4;
/// Compute workgroup width.
const WORKGROUP: u32 = 64;
/// Stride of the T2 tile uniforms (`min_uniform_buffer_offset_alignment`).
const TILE_STRIDE: u64 = 256;
/// Byte offset of `k_from_c` in [`LineUniforms`].
const K_FROM_C_OFFSET: u64 = std::mem::offset_of!(LineUniforms, k_from_c) as u64;

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
    /// At most `max_series` series fit (value capacity or record height).
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
    /// `tex_w = min(4096, max_dim)`; `series ≤ max_dim` (records are one row per series) and
    /// `⌈S·n / tex_w²⌉ ≤ max_layers`, else `TooLarge { min(⌊max_layers·tex_w²/n⌋, max_dim) }`.
    pub fn new(
        series: u32,
        n: u32,
        max_dim: u32,
        max_layers: u32,
    ) -> Result<LineLayout, LayoutError> {
        let tex_w = MAX_TEX_W.min(max_dim).max(1);
        let per_layer = u64::from(tex_w) * u64::from(tex_w);
        let total = u64::from(series) * u64::from(n);
        let value_layers = total.div_ceil(per_layer).max(1);
        if series > max_dim || value_layers > u64::from(max_layers) {
            let fit =
                (u64::from(max_layers) * per_layer / u64::from(n.max(1))).min(u64::from(max_dim));
            return Err(LayoutError::TooLarge {
                max_series: fit as u32,
            });
        }
        let levels = levels_for(n).min(MAX_LEVELS);
        let mut pyr_base = [0u32; 4];
        let mut pyr_len = [0u32; 4];
        let mut base = 0u64;
        let mut size = 1u64;
        for l in 0..levels as usize {
            size *= u64::from(dash_scales::lod::PYRAMID_B);
            pyr_base[l] = base as u32;
            pyr_len[l] = u64::from(n).div_ceil(size) as u32;
            base += u64::from(series) * u64::from(pyr_len[l]);
        }
        Ok(LineLayout {
            series,
            n,
            tex_w,
            value_layers: value_layers as u32,
            pyr_layers: base.div_ceil(per_layer).max(1) as u32,
            levels,
            pyr_base,
            pyr_len,
        })
    }

    pub fn info(&self) -> LayoutInfo {
        LayoutInfo {
            tex_w: self.tex_w,
            levels: self.levels,
            pyr_base: self.pyr_base,
            pyr_len: self.pyr_len,
        }
    }

    /// Texels of the pyramid (all levels, all series).
    fn pyr_texels(&self) -> u64 {
        match self.levels {
            0 => 0,
            l => {
                let l = l as usize - 1;
                u64::from(self.pyr_base[l]) + u64::from(self.series) * u64::from(self.pyr_len[l])
            }
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

/// Splits `[start, start + len)` of a `tex_w × tex_w × layers` texture into a partial first
/// row, blocks of full rows (within a layer) and a partial last row.
pub fn linear_rects(start: u64, len: u64, tex_w: u32) -> Vec<TexRect> {
    let w = u64::from(tex_w.max(1));
    let per_layer = w * w;
    let end = start + len;
    let mut out = Vec::new();
    let mut x = start;
    while x < end {
        let layer = x / per_layer;
        let row = (x % per_layer) / w;
        let col = x % w;
        let (rw, rh) = if col != 0 || end - x < w {
            ((w - col).min(end - x), 1)
        } else {
            (w, ((end - x) / w).min(w - row))
        };
        out.push(TexRect {
            x: col as u32,
            y: row as u32,
            layer: layer as u32,
            w: rw as u32,
            h: rh as u32,
            src: (x - start) as usize,
        });
        x += rw * rh;
    }
    out
}

/// A 2D (array) texture of `format`.
fn texture(
    device: &wgpu::Device,
    label: &str,
    format: wgpu::TextureFormat,
    (w, h, layers): (u32, u32, u32),
    usage: wgpu::TextureUsages,
) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d {
            width: w.max(1),
            height: h.max(1),
            depth_or_array_layers: layers.max(1),
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn view(t: &wgpu::Texture, dim: wgpu::TextureViewDimension) -> wgpu::TextureView {
    t.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(dim),
        ..Default::default()
    })
}

/// Size of a linear texture of `texels`: one short layer, or full `tex_w²` layers.
fn linear_size(texels: u64, tex_w: u32, min_layers: u32) -> (u32, u32, u32) {
    let w = u64::from(tex_w);
    let layers = texels.div_ceil(w * w).max(1);
    let h = if layers == 1 {
        texels.div_ceil(w).max(1)
    } else {
        w
    };
    (tex_w, h as u32, (layers as u32).max(min_layers))
}

fn uint_texture(
    binding: u32,
    dim: wgpu::TextureViewDimension,
    vis: wgpu::ShaderStages,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: vis,
        ty: wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Uint,
            view_dimension: dim,
            multisampled: false,
        },
        count: None,
    }
}

fn uniform(
    binding: u32,
    vis: wgpu::ShaderStages,
    size: u64,
    dynamic: bool,
) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: vis,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: dynamic,
            min_binding_size: wgpu::BufferSize::new(size),
        },
        count: None,
    }
}

fn storage(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::StorageTexture {
            access: wgpu::StorageTextureAccess::WriteOnly,
            format: wgpu::TextureFormat::Rgba32Uint,
            view_dimension: wgpu::TextureViewDimension::D2Array,
        },
        count: None,
    }
}

fn entry(binding: u32, resource: wgpu::BindingResource<'_>) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource }
}

/// The slot-sized textures: bounds and records.
#[derive(Debug)]
struct Records {
    capacity: u32,
    tile_w: u32,
    tiles: u32,
    bounds: wgpu::Texture,
    rec_a: wgpu::Texture,
    rec_b: wgpu::Texture,
    rec_k: wgpu::Texture,
    /// Per tile layer (Fragment path targets).
    layers_a: Vec<wgpu::TextureView>,
    layers_b: Vec<wgpu::TextureView>,
}

impl Records {
    fn new(
        device: &wgpu::Device,
        capacity: u32,
        rows: u32,
        max_dim: u32,
        path: DecimatePath,
    ) -> Records {
        let capacity = capacity.max(1);
        let tile_w = capacity.min(max_dim.max(1));
        let tiles = capacity.div_ceil(tile_w);
        let min_layers = if path == DecimatePath::Fragment { 2 } else { 1 };
        let layers = tiles.max(min_layers);
        let copy = wgpu::TextureUsages::COPY_SRC | wgpu::TextureUsages::COPY_DST;
        let written = match path {
            DecimatePath::Compute => wgpu::TextureUsages::STORAGE_BINDING,
            DecimatePath::Fragment => wgpu::TextureUsages::RENDER_ATTACHMENT,
        };
        let rec = |label| {
            texture(
                device,
                label,
                wgpu::TextureFormat::Rgba32Uint,
                (tile_w, rows, layers),
                written | wgpu::TextureUsages::TEXTURE_BINDING | copy,
            )
        };
        let (rec_a, rec_b) = (rec("line rec_a"), rec("line rec_b"));
        let rec_k = texture(
            device,
            "line rec_k",
            wgpu::TextureFormat::R32Uint,
            (tile_w, rows, layers),
            wgpu::TextureUsages::TEXTURE_BINDING | copy,
        );
        let bounds = texture(
            device,
            "line bounds",
            wgpu::TextureFormat::R32Uint,
            (tile_w, (capacity + 1).div_ceil(tile_w), 1),
            wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        );
        let per_layer = |t: &wgpu::Texture| -> Vec<wgpu::TextureView> {
            if path == DecimatePath::Compute {
                return Vec::new();
            }
            (0..tiles)
                .map(|l| {
                    t.create_view(&wgpu::TextureViewDescriptor {
                        dimension: Some(wgpu::TextureViewDimension::D2),
                        base_array_layer: l,
                        array_layer_count: Some(1),
                        ..Default::default()
                    })
                })
                .collect()
        };
        let layers_a = per_layer(&rec_a);
        let layers_b = per_layer(&rec_b);
        Records {
            capacity,
            tile_w,
            tiles,
            bounds,
            rec_a,
            rec_b,
            rec_k,
            layers_a,
            layers_b,
        }
    }
}

/// The decimation pipeline of a path.
#[derive(Debug)]
enum Decimator {
    Compute(wgpu::ComputePipeline),
    Fragment {
        pipeline: wgpu::RenderPipeline,
        tiles: wgpu::Buffer,
    },
}

/// The T2 tile uniforms: tile `t`'s layer index at byte `t · 256`.
fn tile_buffer(device: &wgpu::Device, tiles: u32) -> wgpu::Buffer {
    let stride = (TILE_STRIDE / 4) as usize;
    let mut words = vec![0u32; stride * tiles.max(1) as usize];
    for t in 0..tiles as usize {
        words[t * stride] = t as u32;
    }
    wgpu::util::DeviceExt::create_buffer_init(
        device,
        &wgpu::util::BufferInitDescriptor {
            label: Some("line tiles"),
            contents: bytemuck::cast_slice(&words),
            usage: wgpu::BufferUsages::UNIFORM,
        },
    )
}

/// A cleared, stored colour attachment.
fn target(v: &wgpu::TextureView) -> Option<wgpu::RenderPassColorAttachment<'_>> {
    Some(wgpu::RenderPassColorAttachment {
        view: v,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations {
            load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
            store: wgpu::StoreOp::Store,
        },
    })
}

/// What the last `set_frame` drew.
#[derive(Clone, Copy, Debug, PartialEq)]
struct FrameState {
    slots: u32,
    series: u32,
    canvas: [f32; 2],
    plot: Plot,
}

/// The line mark's GPU state.
#[derive(Debug)]
pub struct LineMark {
    layout: LineLayout,
    path: DecimatePath,
    max_dim: u32,
    values: wgpu::Texture,
    pyramid: wgpu::Texture,
    values_view: wgpu::TextureView,
    pyramid_view: wgpu::TextureView,
    uniforms: wgpu::Buffer,
    records: Records,
    decimate_layout: wgpu::BindGroupLayout,
    draw_layout: wgpu::BindGroupLayout,
    decimator: Decimator,
    draw_pipeline: wgpu::RenderPipeline,
    mask_pipeline: wgpu::RenderPipeline,
    decimate_group: wgpu::BindGroup,
    draw_group: wgpu::BindGroup,
    frame: Option<FrameState>,
    k_from_c: Cell<bool>,
    staging: Vec<u32>,
    draws: Cell<u32>,
}

/// `{One, One, Max}` on colour and alpha: the union of coverages (§4.4).
const MAX_BLEND: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Max,
    },
    alpha: wgpu::BlendComponent {
        src_factor: wgpu::BlendFactor::One,
        dst_factor: wgpu::BlendFactor::One,
        operation: wgpu::BlendOperation::Max,
    },
};

fn draw_pipeline(
    device: &wgpu::Device,
    layout: &wgpu::PipelineLayout,
    module: &wgpu::ShaderModule,
    fs: &str,
    format: wgpu::TextureFormat,
) -> wgpu::RenderPipeline {
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(fs),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs_line"),
            compilation_options: Default::default(),
            buffers: &[],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(fs),
            compilation_options: Default::default(),
            targets: &[Some(wgpu::ColorTargetState {
                format,
                blend: Some(MAX_BLEND),
                write_mask: wgpu::ColorWrites::ALL,
            })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

impl LineMark {
    /// Creates the textures and pipelines of `layout` for a target of `format`, with record
    /// textures for `slots` slots (grown by [`LineMark::set_frame`]). `max_dim` = the device's
    /// `max_texture_dimension_2d` (tests pass less to force tiling).
    pub fn new(
        device: &wgpu::Device,
        format: wgpu::TextureFormat,
        layout: LineLayout,
        path: DecimatePath,
        slots: u32,
        max_dim: u32,
    ) -> LineMark {
        let min_layers = if path == DecimatePath::Fragment { 2 } else { 1 };
        let sampled = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
        let values = texture(
            device,
            "line values",
            wgpu::TextureFormat::R32Uint,
            linear_size(
                u64::from(layout.series) * u64::from(layout.n),
                layout.tex_w,
                min_layers,
            ),
            sampled,
        );
        let pyramid = texture(
            device,
            "line pyramid",
            wgpu::TextureFormat::Rgba32Uint,
            linear_size(layout.pyr_texels(), layout.tex_w, min_layers),
            sampled,
        );
        let d2a = wgpu::TextureViewDimension::D2Array;
        let d2 = wgpu::TextureViewDimension::D2;
        let values_view = view(&values, d2a);
        let pyramid_view = view(&pyramid, d2a);
        let u_size = std::mem::size_of::<LineUniforms>() as u64;
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("line uniforms"),
            size: u_size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let records = Records::new(device, slots, layout.series, max_dim, path);

        let vf = wgpu::ShaderStages::VERTEX_FRAGMENT;
        let (dec_stage, mut dec_entries) = match path {
            DecimatePath::Compute => (wgpu::ShaderStages::COMPUTE, vec![storage(4), storage(5)]),
            DecimatePath::Fragment => (
                wgpu::ShaderStages::FRAGMENT,
                vec![uniform(6, wgpu::ShaderStages::FRAGMENT, 16, true)],
            ),
        };
        dec_entries.extend([
            uniform(0, dec_stage, u_size, false),
            uint_texture(1, d2a, dec_stage),
            uint_texture(2, d2a, dec_stage),
            uint_texture(3, d2, dec_stage),
        ]);
        let decimate_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("line decimate"),
            entries: &dec_entries,
        });
        let draw_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("line draw"),
            entries: &[
                uniform(0, vf, u_size, false),
                uint_texture(1, d2a, vf),
                uint_texture(2, d2a, vf),
                uint_texture(3, d2a, vf),
                uint_texture(4, d2a, vf),
                uint_texture(5, d2, vf),
            ],
        });
        let pl = |l: &wgpu::BindGroupLayout| {
            device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
                label: Some("line"),
                bind_group_layouts: &[Some(l)],
                ..Default::default()
            })
        };
        let module = |label, src: &str| {
            device.create_shader_module(wgpu::ShaderModuleDescriptor {
                label: Some(label),
                source: wgpu::ShaderSource::Wgsl(src.into()),
            })
        };
        let dec_pl = pl(&decimate_layout);
        let decimator = match path {
            DecimatePath::Compute => {
                let m = module("line decimate cs", LINE_DECIMATE_CS_WGSL);
                Decimator::Compute(device.create_compute_pipeline(
                    &wgpu::ComputePipelineDescriptor {
                        label: Some("line decimate"),
                        layout: Some(&dec_pl),
                        module: &m,
                        entry_point: Some("cs_decimate"),
                        compilation_options: Default::default(),
                        cache: None,
                    },
                ))
            }
            DecimatePath::Fragment => {
                let m = module("line decimate fs", LINE_DECIMATE_FS_WGSL);
                let target = Some(wgpu::ColorTargetState {
                    format: wgpu::TextureFormat::Rgba32Uint,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                });
                let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                    label: Some("line decimate"),
                    layout: Some(&dec_pl),
                    vertex: wgpu::VertexState {
                        module: &m,
                        entry_point: Some("vs_fullscreen"),
                        compilation_options: Default::default(),
                        buffers: &[],
                    },
                    primitive: wgpu::PrimitiveState::default(),
                    depth_stencil: None,
                    multisample: wgpu::MultisampleState::default(),
                    fragment: Some(wgpu::FragmentState {
                        module: &m,
                        entry_point: Some("fs_decimate"),
                        compilation_options: Default::default(),
                        targets: &[target.clone(), target],
                    }),
                    multiview_mask: None,
                    cache: None,
                });
                let tiles = tile_buffer(device, records.tiles);
                Decimator::Fragment { pipeline, tiles }
            }
        };
        let draw_module = module("line draw", LINE_DRAW_WGSL);
        let draw_pl = pl(&draw_layout);
        let line_pipeline = draw_pipeline(device, &draw_pl, &draw_module, "fs_line", format);
        let mask_pipeline = draw_pipeline(
            device,
            &draw_pl,
            &draw_module,
            "fs_mask",
            wgpu::TextureFormat::R8Unorm,
        );
        let (decimate_group, draw_group) = Self::groups(
            device,
            &decimate_layout,
            &draw_layout,
            &decimator,
            &uniforms,
            (&values_view, &pyramid_view),
            &records,
        );
        LineMark {
            layout,
            path,
            max_dim,
            values,
            pyramid,
            values_view,
            pyramid_view,
            uniforms,
            records,
            decimate_layout,
            draw_layout,
            decimator,
            draw_pipeline: line_pipeline,
            mask_pipeline,
            decimate_group,
            draw_group,
            frame: None,
            k_from_c: Cell::new(false),
            staging: Vec::new(),
            draws: Cell::new(0),
        }
    }

    /// The decimate and draw bind groups over the current record textures.
    #[allow(clippy::too_many_arguments)]
    fn groups(
        device: &wgpu::Device,
        decimate_layout: &wgpu::BindGroupLayout,
        draw_layout: &wgpu::BindGroupLayout,
        decimator: &Decimator,
        uniforms: &wgpu::Buffer,
        (values, pyramid): (&wgpu::TextureView, &wgpu::TextureView),
        r: &Records,
    ) -> (wgpu::BindGroup, wgpu::BindGroup) {
        use wgpu::BindingResource::TextureView as Tv;
        let d2a = wgpu::TextureViewDimension::D2Array;
        let bounds = view(&r.bounds, wgpu::TextureViewDimension::D2);
        let (a, b, k) = (
            view(&r.rec_a, d2a),
            view(&r.rec_b, d2a),
            view(&r.rec_k, d2a),
        );
        let mut dec = vec![
            entry(0, uniforms.as_entire_binding()),
            entry(1, Tv(values)),
            entry(2, Tv(pyramid)),
            entry(3, Tv(&bounds)),
        ];
        match decimator {
            Decimator::Compute(_) => {
                dec.push(entry(4, Tv(&a)));
                dec.push(entry(5, Tv(&b)));
            }
            Decimator::Fragment { tiles, .. } => dec.push(entry(
                6,
                wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: tiles,
                    offset: 0,
                    size: wgpu::BufferSize::new(16),
                }),
            )),
        }
        let decimate = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("line decimate"),
            layout: decimate_layout,
            entries: &dec,
        });
        let draw = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("line draw"),
            layout: draw_layout,
            entries: &[
                entry(0, uniforms.as_entire_binding()),
                entry(1, Tv(&a)),
                entry(2, Tv(&b)),
                entry(3, Tv(&k)),
                entry(4, Tv(values)),
                entry(5, Tv(&bounds)),
            ],
        });
        (decimate, draw)
    }

    /// Writes `src` (texels of `T`) at linear texel `start` of a `tex_w`-wide texture.
    fn write_linear<T: bytemuck::Pod>(
        &self,
        queue: &wgpu::Queue,
        tex: &wgpu::Texture,
        start: u64,
        src: &[T],
    ) {
        let texel = std::mem::size_of::<T>();
        for r in linear_rects(start, src.len() as u64, self.layout.tex_w) {
            let n = (r.w * r.h) as usize;
            queue.write_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: tex,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: r.x,
                        y: r.y,
                        z: r.layer,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                bytemuck::cast_slice(&src[r.src..r.src + n]),
                wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(r.w * texel as u32),
                    rows_per_image: Some(r.h),
                },
                wgpu::Extent3d {
                    width: r.w,
                    height: r.h,
                    depth_or_array_layers: 1,
                },
            );
        }
    }

    /// Uploads series `i`: its value bits and pyramid (copy 2, T04-015).
    pub fn upload_series(&self, queue: &wgpu::Queue, i: u32, bits: &[u32], pyramid: &Pyramid) {
        if i >= self.layout.series {
            return;
        }
        let n = self.layout.n as usize;
        let bits = &bits[..n.min(bits.len())];
        self.write_linear(queue, &self.values, u64::from(i) * n as u64, bits);
        for (l, level) in pyramid
            .levels
            .iter()
            .take(self.layout.levels as usize)
            .enumerate()
        {
            let start = u64::from(self.layout.pyr_base[l])
                + u64::from(i) * u64::from(self.layout.pyr_len[l]);
            let len = level.len().min(self.layout.pyr_len[l] as usize);
            self.write_linear(queue, &self.pyramid, start, &level[..len]);
        }
    }

    /// Writes the frame's uniforms and column bounds; grows the record textures to its slots.
    pub fn set_frame(&mut self, device: &wgpu::Device, queue: &wgpu::Queue, f: &LineFrame) {
        let slots = f.columns.slots();
        if slots > self.records.capacity {
            self.records = Records::new(device, slots, self.layout.series, self.max_dim, self.path);
            if let Decimator::Fragment { tiles, .. } = &mut self.decimator {
                *tiles = tile_buffer(device, self.records.tiles);
            }
            let (d, g) = Self::groups(
                device,
                &self.decimate_layout,
                &self.draw_layout,
                &self.decimator,
                &self.uniforms,
                (&self.values_view, &self.pyramid_view),
                &self.records,
            );
            self.decimate_group = d;
            self.draw_group = g;
        }
        let tile_w = self.records.tile_w;
        let rows = (f.columns.bounds.len() as u32).div_ceil(tile_w).max(1);
        self.staging.clear();
        self.staging.extend_from_slice(&f.columns.bounds);
        self.staging.resize((rows * tile_w) as usize, 0);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.records.bounds,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            bytemuck::cast_slice(&self.staging),
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(tile_w * 4),
                rows_per_image: Some(rows),
            },
            wgpu::Extent3d {
                width: tile_w,
                height: rows,
                depth_or_array_layers: 1,
            },
        );
        let mut u = *f.uniforms;
        u.tile_w = tile_w;
        u.k_from_c = u32::from(self.k_from_c.get());
        u.series = u.series.min(self.layout.series);
        queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&u));
        self.frame = Some(FrameState {
            slots,
            series: u.series,
            canvas: u.canvas_px,
            plot: f.plot,
        });
    }

    /// Computes every record: one compute pass (T1) or one render pass per tile layer (T2).
    pub fn decimate(&self, encoder: &mut wgpu::CommandEncoder) {
        let Some(f) = self.frame.filter(|f| f.series > 0) else {
            return;
        };
        let tile_w = self.records.tile_w;
        let tiles = f.slots.div_ceil(tile_w);
        match &self.decimator {
            Decimator::Compute(p) => {
                let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                    label: Some("line decimate"),
                    timestamp_writes: None,
                });
                pass.set_pipeline(p);
                pass.set_bind_group(0, &self.decimate_group, &[]);
                pass.dispatch_workgroups(tile_w.div_ceil(WORKGROUP), f.series, tiles);
            }
            Decimator::Fragment { pipeline, .. } => {
                for t in 0..tiles {
                    let (Some(a), Some(b)) = (
                        self.records.layers_a.get(t as usize),
                        self.records.layers_b.get(t as usize),
                    ) else {
                        return;
                    };
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("line decimate"),
                        color_attachments: &[target(a), target(b)],
                        ..Default::default()
                    });
                    pass.set_pipeline(pipeline);
                    pass.set_bind_group(
                        0,
                        &self.decimate_group,
                        &[(u64::from(t) * TILE_STRIDE) as u32],
                    );
                    pass.draw(0..3, 0..1);
                }
            }
        }
    }

    fn draw_with(&self, pass: &mut wgpu::RenderPass<'_>, pipeline: &wgpu::RenderPipeline) {
        let Some(f) = self.frame.filter(|f| f.series > 0) else {
            return;
        };
        let top = (f.canvas[1] - f.plot.y0 - f.plot.h as f32).max(0.0) as u32;
        pass.set_scissor_rect(f.plot.x0 as u32, top, f.plot.w, f.plot.h);
        pass.set_pipeline(pipeline);
        pass.set_bind_group(0, &self.draw_group, &[]);
        // Six vertices per quad, two quads per slot and series, one non-instanced draw:
        // software rasterisers pay a fixed cost per instance, so the quads are pulled by
        // vertex index instead (corners [0, 1, 2, 2, 1, 3]).
        pass.draw(0..12 * f.slots * f.series, 0..1);
        self.draws.set(self.draws.get() + 1);
    }

    /// One draw of every slot's run and connector quads; scissor = the plot.
    pub fn draw(&self, pass: &mut wgpu::RenderPass<'_>) {
        self.draw_with(pass, &self.draw_pipeline);
    }

    /// Golden reference: replaces the records of `series` and its per-slot `k` (`rec_k`), and
    /// switches the draw to `k_from_c = 1`.
    pub fn write_records(&self, queue: &wgpu::Queue, recs: &[SlotRecord], ks: &[u32], series: u32) {
        if !self.k_from_c.replace(true) {
            queue.write_buffer(&self.uniforms, K_FROM_C_OFFSET, bytemuck::bytes_of(&1u32));
        }
        let tile_w = self.records.tile_w as usize;
        let a: Vec<[u32; 4]> = recs.iter().map(|r| r.a).collect();
        let b: Vec<[u32; 4]> = recs.iter().map(|r| r.b).collect();
        let n = recs.len().min(ks.len());
        for (t, start) in (0..n).step_by(tile_w).enumerate() {
            let len = (n - start).min(tile_w);
            let at = wgpu::Origin3d {
                x: 0,
                y: series,
                z: t as u32,
            };
            let size = wgpu::Extent3d {
                width: len as u32,
                height: 1,
                depth_or_array_layers: 1,
            };
            for (tex, bytes, texel) in [
                (
                    &self.records.rec_a,
                    bytemuck::cast_slice::<[u32; 4], u8>(&a[start..start + len]),
                    16,
                ),
                (
                    &self.records.rec_b,
                    bytemuck::cast_slice(&b[start..start + len]),
                    16,
                ),
                (
                    &self.records.rec_k,
                    bytemuck::cast_slice(&ks[start..start + len]),
                    4,
                ),
            ] {
                queue.write_texture(
                    wgpu::TexelCopyTextureInfo {
                        texture: tex,
                        mip_level: 0,
                        origin: at,
                        aspect: wgpu::TextureAspect::All,
                    },
                    bytes,
                    wgpu::TexelCopyBufferLayout {
                        offset: 0,
                        bytes_per_row: Some(len as u32 * texel),
                        rows_per_image: Some(1),
                    },
                    size,
                );
            }
        }
    }

    /// Binary line coverage (§4.4 mask pass) into an `R8Unorm` target: 255 iff covered.
    pub fn draw_mask(&self, pass: &mut wgpu::RenderPass<'_>) {
        self.draw_with(pass, &self.mask_pipeline);
    }

    /// The record textures (`rec_a`, `rec_b`), for readback.
    pub fn record_textures(&self) -> [&wgpu::Texture; 2] {
        [&self.records.rec_a, &self.records.rec_b]
    }

    /// The record tile width (slots per texture row).
    pub fn tile_w(&self) -> u32 {
        self.records.tile_w
    }

    /// Draw calls since the last call.
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
