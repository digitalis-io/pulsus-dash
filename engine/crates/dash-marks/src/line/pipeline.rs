//! The line mark's pipelines: P1–P5 compute (`decimate.wgsl`, `link.wgsl`, `scan.wgsl`) and the
//! capsule render pipeline (`line.wgsl`): triangle list, 6 vertices per instance, `LineInstance` as
//! an instance vertex buffer, `src-alpha, one-minus-src-alpha` blending, no depth, no MSAA.

use dash_gpu::GpuContext;

use super::gpu::INSTANCE_BYTES;

#[derive(Debug)]
pub(super) struct Pipelines {
    pub(super) pass_bgl: wgpu::BindGroupLayout,
    pub(super) data_bgl: wgpu::BindGroupLayout,
    pub(super) view_bgl: wgpu::BindGroupLayout,
    pub(super) reduce: wgpu::ComputePipeline,
    pub(super) count: wgpu::ComputePipeline,
    pub(super) scan: wgpu::ComputePipeline,
    pub(super) emit: wgpu::ComputePipeline,
    pub(super) spill: wgpu::ComputePipeline,
    pub(super) line: wgpu::RenderPipeline,
}

fn storage_entry(binding: u32, read_only: bool) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only },
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

fn uniform_entry(visibility: wgpu::ShaderStages) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding: 0,
        visibility,
        ty: wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Uniform,
            has_dynamic_offset: false,
            min_binding_size: None,
        },
        count: None,
    }
}

/// The decimation compute pipelines (explicit layouts: one uniform group, one data group of eight
/// storage buffers) and the line render pipeline.
pub(super) fn pipelines(ctx: &GpuContext, format: wgpu::TextureFormat) -> Pipelines {
    let d = &ctx.device;
    let module = |label: &str, src: &str| {
        d.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some(label),
            source: wgpu::ShaderSource::Wgsl(src.into()),
        })
    };
    let decimate_m = module("decimate.wgsl", include_str!("decimate.wgsl"));
    let link_m = module("link.wgsl", include_str!("link.wgsl"));
    let scan_m = module("scan.wgsl", include_str!("scan.wgsl"));
    let line_m = module("line.wgsl", include_str!("line.wgsl"));
    let pass_bgl = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("pass"),
        entries: &[uniform_entry(wgpu::ShaderStages::COMPUTE)],
    });
    let mut entries: Vec<wgpu::BindGroupLayoutEntry> =
        (0..3).map(|b| storage_entry(b, true)).collect();
    entries.extend((3..8).map(|b| storage_entry(b, false)));
    let data_bgl = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("data"),
        entries: &entries,
    });
    let view_bgl = d.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("view"),
        entries: &[uniform_entry(
            wgpu::ShaderStages::VERTEX | wgpu::ShaderStages::FRAGMENT,
        )],
    });
    let compute_layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("decimation"),
        bind_group_layouts: &[Some(&pass_bgl), Some(&data_bgl)],
        immediate_size: 0,
    });
    let compute = |m: &wgpu::ShaderModule, entry: &str| {
        d.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some(entry),
            layout: Some(&compute_layout),
            module: m,
            entry_point: Some(entry),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            cache: None,
        })
    };
    let render_layout = d.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
        label: Some("line"),
        bind_group_layouts: &[Some(&view_bgl)],
        immediate_size: 0,
    });
    let attributes = wgpu::vertex_attr_array![0 => Uint32, 1 => Float32, 2 => Float32, 3 => Uint32];
    let line = d.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("line"),
        layout: Some(&render_layout),
        vertex: wgpu::VertexState {
            module: &line_m,
            entry_point: Some("vs"),
            compilation_options: wgpu::PipelineCompilationOptions::default(),
            buffers: &[Some(wgpu::VertexBufferLayout {
                array_stride: INSTANCE_BYTES,
                step_mode: wgpu::VertexStepMode::Instance,
                attributes: &attributes,
            })],
        },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &line_m,
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
    Pipelines {
        reduce: compute(&decimate_m, "reduce"),
        spill: compute(&decimate_m, "spill"),
        count: compute(&link_m, "count"),
        emit: compute(&link_m, "emit"),
        scan: compute(&scan_m, "scan"),
        line,
        pass_bgl,
        data_bgl,
        view_bgl,
    }
}
