#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Commands are logged and reported without their environment (review r1 #1): a credential or the
//! PulsusDB URL passed by `dev up` or `ci itest` never reaches the output.

use std::process::Command;

use xtask::tools::{display, run};

const SENTINELS: [&str; 3] = [
    "sentinel-pw-4711",
    "pulsusdb.sentinel.invalid",
    "p-tok-sentinel",
];

fn with_secrets(program: &str) -> Command {
    let mut c = Command::new(program);
    c.arg("--config")
        .arg("dev/pulsus-dash.dev.yaml")
        .env("PDB_CRED", "reader:sentinel-pw-4711")
        .env(
            "PULSUS_DASH_DATASOURCES_BOOTSTRAP__0__URL",
            "http://pulsusdb.sentinel.invalid:9/p-tok-sentinel/",
        )
        .env(
            "DATABASE_URL",
            "postgres://pulsus_owner:sentinel-pw-4711@localhost:1/x",
        );
    c
}

#[test]
fn command_display_omits_environment() {
    let shown = display(&with_secrets("pulsus-dash"));
    assert!(shown.contains("pulsus-dash"), "{shown}");
    assert!(shown.contains("dev/pulsus-dash.dev.yaml"), "{shown}");
    for s in SENTINELS {
        assert!(!shown.contains(s), "{shown}");
    }
}

#[test]
fn failed_command_error_omits_environment() {
    let e = run(&mut with_secrets("false")).unwrap_err().to_string();
    let missing = run(&mut with_secrets("xtask-no-such-program"))
        .unwrap_err()
        .to_string();
    for s in SENTINELS {
        assert!(!e.contains(s), "{e}");
        assert!(!missing.contains(s), "{missing}");
    }
}

#[test]
fn no_debug_formatted_commands_in_xtask() {
    // `{cmd:?}` prints explicitly set environment variables; only `display` may format a command.
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for f in std::fs::read_dir(src).unwrap() {
        let p = f.unwrap().path();
        let text = std::fs::read_to_string(&p).unwrap();
        let n = text.matches("{cmd:?}").count();
        let allowed = usize::from(p.ends_with("tools.rs"));
        assert!(
            n <= allowed,
            "{}: {n} debug-formatted command(s)",
            p.display()
        );
    }
}
