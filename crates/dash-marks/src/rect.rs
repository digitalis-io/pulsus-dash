//! Minimal M3 rect pipeline for the #23 spike: one instanced draw (VIZ-001). #24 adds radius and
//! border. Stub.

use dash_scene::spike::SpikeUniforms;

/// The WGSL source: `vs_main`, `fs_main`.
pub const RECT_WGSL: &str = include_str!("rect.wgsl");

/// Pipeline, layout, uniform buffer and bind group of the rect mark.
#[derive(Debug)]
pub struct RectPipeline {
    uniforms: wgpu::Buffer,
}

impl RectPipeline {
    pub fn new(device: &wgpu::Device, _format: wgpu::TextureFormat) -> Self {
        let uniforms = device.create_buffer(&wgpu::BufferDescriptor {
            label: None,
            size: 48,
            usage: wgpu::BufferUsages::UNIFORM,
            mapped_at_creation: false,
        });
        RectPipeline { uniforms }
    }

    /// Instance slots: 0 `xy` Float32x2, 1 `phase` Float32.
    pub fn draw(
        &self,
        _pass: &mut wgpu::RenderPass<'_>,
        _queue: &wgpu::Queue,
        _u: &SpikeUniforms,
        _xy: &wgpu::Buffer,
        _phase: &wgpu::Buffer,
        _n: u32,
    ) {
        let _ = &self.uniforms;
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
