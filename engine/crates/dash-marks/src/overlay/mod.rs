//! The overlay pipeline (plan #68 C2b §3.2, feature `gpu`): the crosshair, the hover dots and the
//! box band of a `MarkItem::Overlay`, drawn by `Renderer::draw` after every line and guide of the
//! frame, in a pass of its own with `LoadOp::Load` (or the clear when nothing came before), no
//! scissor and the line pipeline's blend. One instanced quad per shape, in CSS px × dpr, with no
//! `view_proj`; the same on T1 and T2 (no storage buffer, no compute).

use dash_gpu::GpuContext;

use crate::desc::OverlayShape;

/// One shape: `geom` is a rect's x, y, w, h or a disc's centre and radius (CSS px); `kind` 0 rect,
/// 1 disc.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct ShapeInst {
    geom: [f32; 4],
    colour: [f32; 4],
    kind: f32,
    pad: [f32; 3],
}

impl From<&OverlayShape> for ShapeInst {
    fn from(s: &OverlayShape) -> Self {
        match *s {
            OverlayShape::Rect { css, colour } => Self {
                geom: css,
                colour: colour.to_f32(),
                kind: 0.0,
                pad: [0.0; 3],
            },
            OverlayShape::Disc {
                centre,
                r_css,
                colour,
            } => Self {
                geom: [centre[0], centre[1], r_css, 0.0],
                colour: colour.to_f32(),
                kind: 1.0,
                pad: [0.0; 3],
            },
        }
    }
}

/// The overlay uniform (`overlay.wgsl` `U`).
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct OverlayU {
    device_px: [f32; 2],
    dpr: f32,
    pad: f32,
}

const INST_BYTES: u64 = std::mem::size_of::<ShapeInst>() as u64;
/// The instance buffer starts at 64 shapes and doubles as needed (never shrunk).
const MIN_SHAPES: u64 = 64;

/// The overlay pipeline and its buffers. One per renderer.
#[derive(Debug)]
pub(crate) struct Overlay {
    pipeline: wgpu::RenderPipeline,
    bind: wgpu::BindGroup,
    uniform: wgpu::Buffer,
    instances: wgpu::Buffer,
    cap: u64,
}

fn instance_buffer(ctx: &GpuContext, shapes: u64) -> wgpu::Buffer {
    ctx.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("overlay instances"),
        size: shapes * INST_BYTES,
        usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    })
}

impl Overlay {
    pub(crate) fn new(ctx: &GpuContext, format: wgpu::TextureFormat) -> Self {
        let d = &ctx.device;
        let module = d.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("overlay.wgsl"),
            source: wgpu::ShaderSource::Wgsl(include_str!("overlay.wgsl").into()),
        });
        let bgl = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("overlay"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: None,
                },
                count: None,
            }],
        });
        let layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("overlay"),
            bind_group_layouts: &[Some(&bgl)],
            immediate_size: 0,
        });
        let attributes = wgpu::vertex_attr_array![0 => Float32x4, 1 => Float32x4, 2 => Float32];
        let pipeline = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("overlay"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: INST_BYTES,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &attributes,
                })],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: wgpu::PipelineCompilationOptions::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let uniform = d.create_buffer(&wgpu::BufferDescriptor {
            label: Some("overlay uniform"),
            size: std::mem::size_of::<OverlayU>() as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind = d.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("overlay"),
            layout: &bgl,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniform.as_entire_binding(),
            }],
        });
        Self {
            pipeline,
            bind,
            uniform,
            instances: instance_buffer(ctx, MIN_SHAPES),
            cap: MIN_SHAPES,
        }
    }

    /// One pass over `view` (`size` device px) drawing `shapes` in order, `load` first.
    pub(crate) fn draw(
        &mut self,
        ctx: &GpuContext,
        view: &wgpu::TextureView,
        size: (u32, u32),
        dpr: f32,
        load: wgpu::LoadOp<wgpu::Color>,
        shapes: &[OverlayShape],
    ) {
        let n = shapes.len() as u64;
        if n > self.cap {
            self.cap = n.next_power_of_two();
            self.instances = instance_buffer(ctx, self.cap);
        }
        if n > 0 {
            let inst: Vec<ShapeInst> = shapes.iter().map(ShapeInst::from).collect();
            ctx.queue
                .write_buffer(&self.instances, 0, bytemuck::cast_slice(&inst));
            let u = OverlayU {
                device_px: [size.0 as f32, size.1 as f32],
                dpr,
                pad: 0.0,
            };
            ctx.queue
                .write_buffer(&self.uniform, 0, bytemuck::bytes_of(&u));
        }
        let mut enc = ctx.device.create_command_encoder(&Default::default());
        {
            let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("overlay"),
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
            if n > 0 {
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.bind, &[]);
                pass.set_vertex_buffer(0, self.instances.slice(..n * INST_BYTES));
                pass.draw(0..6, 0..n as u32);
            }
        }
        ctx.queue.submit([enc.finish()]);
    }
}
