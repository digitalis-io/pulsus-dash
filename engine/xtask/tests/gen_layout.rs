//! ci:engine-gen, layout leg (plan #68 C1 §3.2, §5; T03-005): `cargo xtask gen-layout --check`
//! passes on the committed `layout.gen.ts`, fails on a stale one, and `gen-layout` rewrites it.
use std::path::{Path, PathBuf};
use std::process::Command;

fn xtask(args: &[&str], root: &Path) -> (i32, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(args)
        .arg("--root")
        .arg(root)
        .output();
    let Ok(out) = out else { panic!("run xtask") };
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn engine() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

#[test]
fn committed_layout_passes_the_check() {
    let (code, err) = xtask(&["gen-layout", "--check"], &engine());
    assert_eq!(code, 0, "{err}");
}

#[test]
fn a_stale_layout_fails_and_is_rewritten() {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("gen-layout");
    let _ = std::fs::remove_dir_all(&dir);
    let root = dir.join("engine");
    let file = dir.join("client/src/engine/wasm/layout.gen.ts");
    assert!(std::fs::create_dir_all(&root).is_ok());
    assert!(
        file.parent()
            .is_some_and(|p| std::fs::create_dir_all(p).is_ok())
    );
    assert!(std::fs::write(&file, "export const LAYOUT_VERSION = 0;\n").is_ok());
    let (code, err) = xtask(&["gen-layout", "--check"], &root);
    assert_eq!(code, 1, "{err}");
    assert!(err.contains("layout.gen.ts"), "{err}");
    let (code, err) = xtask(&["gen-layout"], &root);
    assert_eq!(code, 0, "{err}");
    let (code, err) = xtask(&["gen-layout", "--check"], &root);
    assert_eq!(code, 0, "{err}");
    let real = std::fs::read_to_string(engine().join("../client/src/engine/wasm/layout.gen.ts"));
    assert_eq!(std::fs::read_to_string(&file).ok(), real.ok());
}
