//! Minimal M3 rect pipeline for the #23 spike: one instanced draw (VIZ-001). #24 adds radius and
//! border.

use dash_scene::spike::SpikeUniforms;

/// The WGSL source: `vs_main`, `fs_main`.
pub const RECT_WGSL: &str = include_str!("rect.wgsl");

/// Pipeline, layout, uniform buffer and bind group of the rect mark.
#[derive(Debug)]
pub struct RectPipeline {
    pipeline: wgpu::RenderPipeline,
    uniforms: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
}

const INSTANCE_XY: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![0 => Float32x2];
const INSTANCE_PHASE: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![1 => Float32];

impl RectPipeline {
    /// Builds the pipeline for a surface of `format`.
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("rect"),
            source: wgpu::ShaderSource::Wgsl(RECT_WGSL.into()),
        });
        let uniform_size = std::mem::size_of::<SpikeUniforms>() as wgpu::BufferAddress;
        let bind_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("rect"),
            entries: &[wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::VERTEX,
                ty: wgpu::BindingType::Buffer {
                    ty: wgpu::BufferBindingType::Uniform,
                    has_dynamic_offset: false,
                    min_binding_size: wgpu::BufferSize::new(uniform_size),
                },
                count: None,
            }],
        });
        let layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("rect"),
            bind_group_layouts: &[Some(&bind_layout)],
            ..Default::default()
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("rect"),
            layout: Some(&layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                compilation_options: Default::default(),
                buffers: &[
                    Some(wgpu::VertexBufferLayout {
                        array_stride: 8,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &INSTANCE_XY,
                    }),
                    Some(wgpu::VertexBufferLayout {
                        array_stride: 4,
                        step_mode: wgpu::VertexStepMode::Instance,
                        attributes: &INSTANCE_PHASE,
                    }),
                ],
            },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("rect uniforms"),
            size: uniform_size,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("rect"),
            layout: &bind_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: uniforms.as_entire_binding(),
            }],
        });
        RectPipeline {
            pipeline,
            uniforms,
            bind_group,
        }
    }

    /// Writes the uniforms and records exactly one `draw(0..6, 0..n)`.
    /// Instance slots: 0 `xy` Float32x2, 1 `phase` Float32.
    pub fn draw(
        &self,
        pass: &mut wgpu::RenderPass<'_>,
        queue: &wgpu::Queue,
        u: &SpikeUniforms,
        xy: &wgpu::Buffer,
        phase: &wgpu::Buffer,
        n: u32,
    ) {
        queue.write_buffer(&self.uniforms, 0, bytemuck::bytes_of(u));
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &self.bind_group, &[]);
        pass.set_vertex_buffer(0, xy.slice(..));
        pass.set_vertex_buffer(1, phase.slice(..));
        pass.draw(0..6, 0..n);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module() -> naga::Module {
        naga::front::wgsl::parse_str(RECT_WGSL).expect("WGSL parses")
    }

    fn validate(m: &naga::Module) -> naga::valid::ModuleInfo {
        naga::valid::Validator::new(
            naga::valid::ValidationFlags::all(),
            naga::valid::Capabilities::all(),
        )
        .validate(m)
        .expect("WGSL validates")
    }

    #[test]
    fn rect_wgsl_validates() {
        let m = module();
        validate(&m);
        let names: Vec<&str> = m.entry_points.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["vs_main", "fs_main"]);
    }

    #[test]
    fn rect_wgsl_translates_to_glsl_es300() {
        let m = module();
        let info = validate(&m);
        for (stage, entry) in [
            (naga::ShaderStage::Vertex, "vs_main"),
            (naga::ShaderStage::Fragment, "fs_main"),
        ] {
            let options = naga::back::glsl::Options {
                version: naga::back::glsl::Version::Embedded {
                    version: 300,
                    is_webgl: false,
                },
                ..Default::default()
            };
            let pipeline = naga::back::glsl::PipelineOptions {
                shader_stage: stage,
                entry_point: entry.to_string(),
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
            w.write().expect("GLSL ES 300 output");
            assert!(out.starts_with("#version 300 es"), "{out}");
        }
    }
}
