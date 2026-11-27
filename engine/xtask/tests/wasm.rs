//! `cargo xtask build-wasm --st` (plan #68 C2d2 §3.1, §5 `st_features`, `st_flags`, `st_module`):
//! `dash-core-st` has no `+atomics`, shared memory, TLS exports or `build-std`; feature
//! unification cannot pull rayon or `dash-scales/parallel` into it; and the built module exports
//! its own non-shared memory, imports none, and holds no atomic instruction.
use std::path::PathBuf;
use std::process::Command;

fn engine() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// `cargo tree -e features -p dash-core --target wasm32-unknown-unknown` with `args`.
fn tree(args: &[&str]) -> String {
    let out = Command::new(env!("CARGO"))
        .current_dir(engine())
        .args([
            "tree",
            "--locked",
            "-e",
            "features",
            "-p",
            "dash-core",
            "--target",
            "wasm32-unknown-unknown",
        ])
        .args(args)
        .output();
    let out = match out {
        Ok(o) => o,
        Err(e) => panic!("cargo tree: {e}"),
    };
    assert!(
        out.status.success(),
        "cargo tree {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

const PARALLEL: &str = "dash-scales feature \"parallel\"";

#[test]
fn st_features() {
    for features in ["st", "st,probe"] {
        let t = tree(&["--no-default-features", "--features", features]);
        assert!(t.contains("dash-core"), "{features}: {t}");
        assert!(!t.contains("rayon"), "{features}: rayon in the ST tree");
        // dash-scales' own features show in the tree inverted on it.
        let i = tree(&[
            "--no-default-features",
            "--features",
            features,
            "-i",
            "dash-scales",
        ]);
        assert!(i.contains("dash-scales"), "{features}: {i}");
        assert!(
            !i.contains(PARALLEL),
            "{features}: dash-scales/parallel in the ST tree"
        );
    }
    assert!(tree(&[]).contains("rayon"), "the MT tree has rayon");
    let i = tree(&["-i", "dash-scales"]);
    assert!(i.contains(PARALLEL), "the MT tree has dash-scales/parallel");
}

#[test]
fn st_flags() {
    let a = xtask::wasm::build_args(true, false);
    let all = format!(
        "{} {} {}",
        a.rustflags,
        a.cargo.join(" "),
        a.wasm_opt.join(" ")
    );
    for bad in [
        "+atomics",
        "--shared-memory",
        "--import-memory",
        "__tls",
        "build-std",
        "--enable-threads",
    ] {
        assert!(!all.contains(bad), "ST build has {bad}: {all}");
    }
    assert_eq!(a.out_name, "dash_core_st");
    assert!(a.rustflags.contains("+simd128") && a.rustflags.contains("--max-memory=2147483648"));
    let f = a.cargo.iter().position(|s| s == "--features");
    assert!(
        a.cargo.iter().any(|s| s == "--no-default-features")
            && f.and_then(|i| a.cargo.get(i + 1))
                .is_some_and(|s| s == "st"),
        "{:?}",
        a.cargo
    );
    let p = xtask::wasm::build_args(true, true);
    let f = p.cargo.iter().position(|s| s == "--features");
    assert!(
        f.and_then(|i| p.cargo.get(i + 1))
            .is_some_and(|s| s == "st,probe")
    );
    // MT is as before.
    let mt = xtask::wasm::build_args(false, false);
    assert_eq!(mt.out_name, "dash_core_mt");
    assert_eq!(mt.rustflags, xtask::wasm::MT_RUSTFLAGS);
    assert!(mt.wasm_opt.contains(&"--enable-threads"));
    assert!(!mt.cargo.iter().any(|s| s == "--no-default-features"));
}

/// Reads a LEB128 u32 at `*at`.
fn leb(b: &[u8], at: &mut usize) -> u32 {
    let (mut v, mut shift) = (0u32, 0);
    loop {
        let byte = b[*at];
        *at += 1;
        v |= u32::from(byte & 0x7F) << shift;
        if byte & 0x80 == 0 {
            return v;
        }
        shift += 7;
    }
}

fn name(b: &[u8], at: &mut usize) -> String {
    let n = leb(b, at) as usize;
    let s = String::from_utf8_lossy(&b[*at..*at + n]).into_owned();
    *at += n;
    s
}

/// The module's memory imports, its memory limits flags, and its exported memories.
fn memories(b: &[u8]) -> (Vec<String>, Vec<u8>, Vec<String>) {
    assert_eq!(&b[..8], b"\0asm\x01\0\0\0", "not a wasm module");
    let (mut imports, mut flags, mut exports) = (Vec::new(), Vec::new(), Vec::new());
    let mut at = 8;
    while at < b.len() {
        let id = b[at];
        at += 1;
        let size = leb(b, &mut at) as usize;
        let end = at + size;
        let mut p = at;
        match id {
            2 => {
                for _ in 0..leb(b, &mut p) {
                    let m = name(b, &mut p);
                    let f = name(b, &mut p);
                    let kind = b[p];
                    p += 1;
                    match kind {
                        0 => {
                            leb(b, &mut p);
                        }
                        1 => {
                            p += 1;
                            let fl = b[p];
                            p += 1;
                            leb(b, &mut p);
                            if fl & 1 != 0 {
                                leb(b, &mut p);
                            }
                        }
                        2 => {
                            let fl = b[p];
                            p += 1;
                            leb(b, &mut p);
                            if fl & 1 != 0 {
                                leb(b, &mut p);
                            }
                            imports.push(format!("{m}.{f}"));
                        }
                        3 => p += 2,
                        4 => {
                            p += 1;
                            leb(b, &mut p);
                        }
                        k => panic!("import kind {k}"),
                    }
                }
            }
            5 => {
                for _ in 0..leb(b, &mut p) {
                    let fl = b[p];
                    p += 1;
                    leb(b, &mut p);
                    if fl & 1 != 0 {
                        leb(b, &mut p);
                    }
                    flags.push(fl);
                }
            }
            7 => {
                for _ in 0..leb(b, &mut p) {
                    let n = name(b, &mut p);
                    let kind = b[p];
                    p += 1;
                    leb(b, &mut p);
                    if kind == 2 {
                        exports.push(n);
                    }
                }
            }
            _ => {}
        }
        at = end;
    }
    (imports, flags, exports)
}

/// Needs `make engine-wasm-st` (the web image); `make engine-wasm-check` runs it.
#[test]
#[ignore = "needs make engine-wasm-st; run by make engine-wasm-check"]
fn st_module() {
    let dir = std::env::var_os("ST_GEN_DIR").map_or_else(
        || engine().join("../client/src/engine/wasm/gen-st"),
        PathBuf::from,
    );
    let wasm = dir.join("dash_core_st_bg.wasm");
    let b = std::fs::read(&wasm);
    assert!(
        b.is_ok(),
        "{}: {b:?} (run make engine-wasm-st)",
        wasm.display()
    );
    let b = b.unwrap_or_default();
    let (imports, flags, exports) = memories(&b);
    assert_eq!(imports, Vec::<String>::new(), "a memory import");
    assert_eq!(flags.len(), 1, "one memory of its own");
    assert!(
        flags.iter().all(|f| f & 2 == 0),
        "a shared memory: flags {flags:?}"
    );
    assert_eq!(exports, ["memory"], "the memory is exported");
    // No atomic instruction: binaryen reads the module with the ST features only and prints the
    // features it uses; `threads` (atomics, shared memory) must not be among them. The MT module
    // reports `--enable-threads` here.
    let mut cmd = Command::new("wasm-opt");
    cmd.arg(&wasm).arg("--mvp-features");
    for f in xtask::wasm::build_args(true, false).wasm_opt {
        cmd.arg(f);
    }
    let out = cmd.arg("--print-features").output();
    let out = match out {
        Ok(o) => o,
        Err(e) => panic!("wasm-opt: {e}"),
    };
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(out.status.success(), "wasm-opt validation: {text}");
    assert!(!text.contains("threads"), "features: {text}");
}
