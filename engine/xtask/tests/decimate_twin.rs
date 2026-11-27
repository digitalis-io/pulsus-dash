//! unit:decimate-sequential (plan #68 C2d2 §5 `decimate_sequential`; T03-021): the sequential CPU
//! decimation of `dash-core-st` equals the rayon one. Two separately built executables of the
//! `dash-scales` example `decimate-dump`, one without features (sequential) and one with
//! `parallel`, each in its own target directory, dump every output field of the same seeded cases
//! (each float as its bits); the two dumps must be byte-equal.
use std::path::{Path, PathBuf};
use std::process::Command;

fn engine() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Builds `decimate-dump` into `target` with `features` and returns its stdout.
fn dump(target: &Path, features: &[&str]) -> Vec<u8> {
    let build = Command::new(env!("CARGO"))
        .current_dir(engine())
        .args([
            "build",
            "--locked",
            "--release",
            "-p",
            "dash-scales",
            "--example",
            "decimate-dump",
            "--no-default-features",
        ])
        .args(features)
        .arg("--target-dir")
        .arg(target)
        .status();
    assert!(
        build.as_ref().is_ok_and(|s| s.success()),
        "decimate-dump {features:?} did not build: {build:?}"
    );
    let exe = target.join("release/examples/decimate-dump");
    let out = Command::new(&exe).output();
    let out = match out {
        Ok(o) => o,
        Err(e) => panic!("{}: {e}", exe.display()),
    };
    assert!(
        out.status.success(),
        "decimate-dump {features:?}: {:?}",
        out.status
    );
    out.stdout
}

#[test]
fn decimate_sequential() {
    let base = std::env::var_os("CARGO_TARGET_DIR")
        .map_or_else(|| engine().join("target"), PathBuf::from)
        .join("decimate-twin");
    let seq = dump(&base.join("seq"), &[]);
    let par = dump(&base.join("par"), &["--features", "parallel"]);
    assert!(
        seq.len() > 1 << 20,
        "the dump covers the cases ({} bytes)",
        seq.len()
    );
    if let Some(at) = seq.iter().zip(&par).position(|(a, b)| a != b) {
        panic!(
            "the dumps differ at byte {at} (sequential {} B, parallel {} B)",
            seq.len(),
            par.len()
        );
    }
    assert_eq!(seq.len(), par.len(), "the dumps differ in length");
}
