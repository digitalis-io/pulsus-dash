#![allow(clippy::unwrap_used, clippy::expect_used)]
//! The documented default flow: `cargo xtask dev up` on a clean tree builds the assets, starts
//! the stack and serves an isolated page (acceptance; `ci e2e` runs it, plan §4.6).

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

const PROJECT: &str = "pulsus-dash-devup";
const PORT: u16 = 8789;
/// `csp(Some(http://localhost:8789/))`: plain http adds no `upgrade-insecure-requests`.
const CSP: &str = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types pulsus-sanitised; report-to csp";

fn get(path: &str) -> Option<(u16, String)> {
    // `localhost` may resolve to `::1` first; the server binds the first address it resolves.
    let mut s = TcpStream::connect(("localhost", PORT)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(10))).ok()?;
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: localhost:{PORT}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let code = text.split_whitespace().nth(1)?.parse().ok()?;
    Some((code, text))
}

fn header(resp: &str, name: &str) -> Option<String> {
    let head = resp.split("\r\n\r\n").next()?;
    head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case(name).then(|| v.trim().to_string())
    })
}

fn env_cmd(program: &str) -> Command {
    let mut c = Command::new(program);
    c.env_clear();
    for k in ["PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME"] {
        if let Ok(v) = std::env::var(k) {
            c.env(k, v);
        }
    }
    c.env("DASH_DEV_PROJECT", PROJECT)
        .env("DASH_PG_PORT", "57432")
        .env("DASH_PG15_PORT", "57433")
        .env("DASH_IDP_PORT", "7556")
        .env(
            "PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL",
            "http://pulsusdb.invalid:9",
        );
    c
}

/// The `dev up` process; killed and reaped on every exit path (a failed assertion included).
struct Up(Child);

impl Drop for Up {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
#[ignore = "e2e: run by cargo xtask ci e2e"]
fn dev_up_default_flow() {
    let root = xtask::repo_root().unwrap();
    let _ = std::fs::remove_dir_all(root.join("web/shim/gen"));
    let _ = std::fs::remove_dir_all(root.join("target/dev").join(PROJECT));
    let mut up = Up(env_cmd("cargo")
        .args(["xtask", "dev", "up", "--port", &PORT.to_string()])
        .current_dir(&root)
        .stdin(Stdio::null())
        .spawn()
        .unwrap());
    let end = Instant::now() + Duration::from_secs(900);
    let mut started = false;
    while Instant::now() < end {
        if get("/startupz").is_some_and(|r| r.0 == 200) {
            started = true;
            break;
        }
        if let Some(st) = up.0.try_wait().unwrap() {
            panic!("dev up exited early: {st}");
        }
        std::thread::sleep(Duration::from_secs(1));
    }
    assert!(started, "/startupz never answered 200");
    for core in [
        "dash-core-mt/dash_core_mt_bg.wasm",
        "dash-core-st/dash_core_st_bg.wasm",
    ] {
        assert!(root.join("web/shim/gen").join(core).is_file(), "{core}");
    }
    let (code, doc) = get("/").unwrap();
    assert_eq!(code, 200);
    assert_eq!(
        header(&doc, "cross-origin-opener-policy").as_deref(),
        Some("same-origin")
    );
    assert_eq!(
        header(&doc, "cross-origin-embedder-policy").as_deref(),
        Some("require-corp")
    );
    assert_eq!(
        header(&doc, "content-security-policy").as_deref(),
        Some(CSP)
    );
    assert_eq!(get("/readyz").map(|r| r.0), Some(200));
    let pw = Command::new("npx")
        .args(["playwright", "test"])
        .env("DASH_E2E_DEVUP", "1")
        .current_dir(root.join("e2e"))
        .status()
        .unwrap();
    assert!(pw.success(), "playwright devup project failed");
    let _ = Command::new("kill")
        .args(["-TERM", &up.0.id().to_string()])
        .status();
    let end = Instant::now() + Duration::from_secs(35);
    let mut code = None;
    while Instant::now() < end {
        if let Some(st) = up.0.try_wait().unwrap() {
            code = st.code();
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    assert_eq!(code, Some(0), "pulsus-dash did not stop cleanly on SIGTERM");
    let down = env_cmd("cargo")
        .args(["xtask", "dev", "down"])
        .current_dir(&root)
        .status()
        .unwrap();
    assert!(down.success());
    let ps = Command::new("docker")
        .args(["compose", "-p", PROJECT, "ps", "-q"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&ps.stdout).trim().is_empty());
    let _ = Command::new("docker")
        .args(["compose", "-p", PROJECT, "down", "-v"])
        .status();
}
