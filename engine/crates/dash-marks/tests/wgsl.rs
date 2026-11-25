//! The WGSL sources parse and validate with naga (part of `ci:spec-lint`'s WGSL rule, T02-001).
use naga::valid::{Capabilities, ValidationFlags, Validator};

#[test]
fn shaders_validate() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/line");
    let mut seen = 0;
    for name in ["decimate.wgsl", "link.wgsl", "scan.wgsl", "line.wgsl"] {
        let src = std::fs::read_to_string(dir.join(name)).unwrap_or_default();
        assert!(!src.is_empty(), "{name} missing");
        let module = match naga::front::wgsl::parse_str(&src) {
            Ok(m) => m,
            Err(e) => panic!("{name}: {}", e.emit_to_string(&src)),
        };
        let v = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module);
        assert!(v.is_ok(), "{name}: {v:?}");
        seen += 1;
    }
    assert_eq!(seen, 4);
}

/// T2 draws with `line.wgsl` on WebGL2: it must translate to GLSL ES 3.00 (plan #68 C1 §5).
#[test]
fn line_wgsl_translates_to_glsl_es_300() {
    use naga::back::glsl;
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/line/line.wgsl");
    let src = std::fs::read_to_string(path).unwrap_or_default();
    let module = match naga::front::wgsl::parse_str(&src) {
        Ok(m) => m,
        Err(e) => panic!("line.wgsl: {}", e.emit_to_string(&src)),
    };
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module);
    let Ok(info) = info else {
        panic!("line.wgsl: {info:?}")
    };
    let options = glsl::Options {
        version: glsl::Version::new_gles(300),
        ..glsl::Options::default()
    };
    for (stage, entry) in [
        (naga::ShaderStage::Vertex, "vs"),
        (naga::ShaderStage::Fragment, "fs"),
    ] {
        let pipeline = glsl::PipelineOptions {
            shader_stage: stage,
            entry_point: entry.into(),
            multiview: None,
        };
        let mut out = String::new();
        let w = glsl::Writer::new(
            &mut out,
            &module,
            &info,
            &options,
            &pipeline,
            naga::proc::BoundsCheckPolicies::default(),
        );
        let written = w.and_then(|mut w| w.write());
        assert!(written.is_ok(), "{entry}: {written:?}");
        assert!(out.starts_with("#version 300 es"), "{entry}: {}", &out[..out.len().min(40)]);
    }
}
