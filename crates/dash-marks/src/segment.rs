//! Capsule segments (gridlines, axis lines, ticks) of the minimal axes: one instanced draw of
//! anti-aliased capsules, premultiplied "over" blending.

use std::cell::Cell;

/// The WGSL source: `vs_segment`, `fs_segment`.
pub const SEGMENT_WGSL: &str = include_str!("segment_draw.wgsl");

/// The segment uniform block (32 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
struct SegmentUniforms {
    canvas_px: [f32; 2],
    half_w: f32,
    _pad: f32,
    colour: [f32; 4],
}

const INSTANCE: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![0 => Float32x4];

/// Segment pipeline, uniforms and a growable instance buffer.
#[derive(Debug)]
pub struct SegmentMark {
    pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    group: wgpu::BindGroup,
    instances: Option<wgpu::Buffer>,
    draws: Cell<u32>,
}

impl SegmentMark {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("segment"),
            source: wgpu::ShaderSource::Wgsl(SEGMENT_WGSL.into()),
        });
        let size = std::mem::size_of::<SegmentUniforms>() as u64;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("segment"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(size),
                },
                count: None,
            }],
        });
        let pl = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("segment"),
            bind_group_layouts: &[Some(&layout)],
            ..Default::default()
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("segment"),
            layout: Some(&pl),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_segment"),
                compilation_options: Default::default(),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: 16,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &INSTANCE,
                })],
            },
            primitive: wgpu::PrimitiveState {
                topology: wgpu::PrimitiveTopology::TriangleStrip,
                ..Default::default()
            },
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_segment"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("segment uniforms"),
            size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("segment"),
            layout: &layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
        });
        SegmentMark {
            pipeline,
            uniforms,
            group,
            instances: None,
            draws: Cell::new(0),
        }
    }

    /// Draws `segs` (`[x0, y0, x1, y1]`, device px, y up from the canvas bottom) as capsules of
    /// half-width `half_w` in one instanced draw. The instance buffer grows to a power of two.
    #[allow(clippy::too_many_arguments)]
    pub fn draw(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pass: &mut wgpu::RenderPass<'_>,
        canvas_px: [f32; 2],
        half_w: f32,
        colour: [f32; 4],
        segs: &[[f32; 4]],
    ) {
        if segs.is_empty() {
            return;
        }
        let bytes: &[u8] = bytemuck::cast_slice(segs);
        let need = bytes.len() as u64;
        if self.instances.as_ref().is_none_or(|b| b.size() < need) {
            self.instances = Some(device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("segment instances"),
                size: need.next_power_of_two().max(256),
                usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            }));
        }
        let Some(instances) = &self.instances else {
            return;
        };
        queue.write_buffer(instances, 0, bytes);
        let u = SegmentUniforms {
            canvas_px,
            half_w,
            _pad: 0.0,
            colour,
        };
        queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(&u));
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.group, &[]);
        pass.set_vertex_buffer(0, instances.slice(..need));
        pass.draw(0..4, 0..segs.len() as u32);
        self.draws.set(self.draws.get() + 1);
    }

    /// Draw calls recorded since the last call.
    pub fn take_draw_count(&self) -> u32 {
        self.draws.replace(0)
    }
}
