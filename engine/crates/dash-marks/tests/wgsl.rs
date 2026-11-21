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
