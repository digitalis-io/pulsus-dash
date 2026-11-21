//! ci:spec-lint, subset (plan #68 §5, §3.13; T02-001, VIZ-002, T05-004): a GPU edge into
//! `dash-scene` and a Dockerfile literal that differs from `tools.toml` both fail; the real
//! workspace passes.
use std::path::{Path, PathBuf};
use std::process::Command;

fn engine() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

fn copy_tree(from: &Path, to: &Path) {
    let Ok(entries) = std::fs::read_dir(from) else {
        panic!("read {}", from.display())
    };
    assert!(std::fs::create_dir_all(to).is_ok());
    for e in entries.flatten() {
        let name = e.file_name();
        if name == "target" || name == "goldens" {
            continue;
        }
        let (src, dst) = (e.path(), to.join(&name));
        if src.is_dir() {
            copy_tree(&src, &dst);
        } else {
            assert!(std::fs::copy(&src, &dst).is_ok(), "copy {}", src.display());
        }
    }
}

fn spec_lint(root: &Path) -> (i32, String) {
    let out = Command::new(env!("CARGO_BIN_EXE_xtask"))
        .args(["spec-lint", "--root"])
        .arg(root)
        .output();
    let Ok(out) = out else { panic!("run xtask") };
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8_lossy(&out.stderr).into_owned(),
    )
}

fn scratch(name: &str) -> PathBuf {
    let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(name);
    let _ = std::fs::remove_dir_all(&dir);
    copy_tree(&engine(), &dir);
    dir
}

#[test]
fn real_workspace_passes() {
    let (code, err) = spec_lint(&engine());
    assert_eq!(code, 0, "{err}");
}

#[test]
fn gpu_edge_into_dash_scene_fails() {
    let dir = scratch("spec-lint-wgpu");
    let manifest = dir.join("crates/dash-scene/Cargo.toml");
    let text = std::fs::read_to_string(&manifest).unwrap_or_default();
    let edited = text.replacen(
        "[dependencies]\n",
        "[dependencies]\nwgpu.workspace = true\n",
        1,
    );
    assert_ne!(text, edited);
    assert!(std::fs::write(&manifest, edited).is_ok());
    // Refresh the copy's lockfile for the new edge (offline; wgpu is already in it).
    let refreshed = Command::new(env!("CARGO"))
        .args(["metadata", "--format-version", "1", "--offline"])
        .current_dir(&dir)
        .output();
    let Ok(refreshed) = refreshed else {
        panic!("run cargo metadata")
    };
    assert!(
        refreshed.status.success(),
        "cargo metadata in the copy: {}",
        String::from_utf8_lossy(&refreshed.stderr)
    );
    let (code, err) = spec_lint(&dir);
    assert_eq!(code, 1, "{err}");
    assert!(err.contains("dash-scene → wgpu"), "{err}");
}

#[test]
fn dockerfile_literal_must_equal_tools_toml() {
    let dir = scratch("spec-lint-mesa");
    let docker = dir.join("ci/lavapipe.Dockerfile");
    let text = std::fs::read_to_string(&docker).unwrap_or_default();
    let edited = text.replace(
        "mesa-vulkan-drivers=25.2.8-0ubuntu0.24.04.4",
        "mesa-vulkan-drivers=25.2.7-0ubuntu0.24.04.1",
    );
    assert_ne!(text, edited, "the Dockerfile has no pinned Mesa literal");
    assert!(std::fs::write(&docker, edited).is_ok());
    let (code, err) = spec_lint(&dir);
    assert_eq!(code, 1, "{err}");
    assert!(err.contains("25.2.7-0ubuntu0.24.04.1"), "{err}");
}
