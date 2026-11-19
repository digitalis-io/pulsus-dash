//! `cargo xtask ci itest` (plan §4.5): `itest:rls-isolation` and `itest:no-extensions` on the
//! compose stack (Postgres 16, vanilla Postgres 15, Dex), the dev-stack discovery itest and the
//! `.sqlx` cache check. Every step runs; the stack is always taken down.

use std::path::{Path, PathBuf};
use std::process::Command;

use crate::dev::{IDP_WAIT, Stack, build_binary, cargo_sqlx, createdb};
use crate::report::{Rule, Violation};
use crate::{R, XtaskError};

const PROFILE: [&str; 2] = ["--profile", "itest"];

/// Runs `cmd` with inherited output; `false` (and a printed note) on failure to start or a
/// non-zero exit.
fn step(name: &str, cmd: &mut Command) -> bool {
    println!("==> itest {name}\n$ {cmd:?}");
    match cmd.status() {
        Ok(s) if s.success() => true,
        Ok(s) => {
            println!("itest {name}: failed ({s})");
            false
        }
        Err(e) => {
            println!("itest {name}: cannot start: {e}");
            false
        }
    }
}

fn cargo_test(root: &Path, args: &[&str]) -> Command {
    let mut c = Command::new("cargo");
    c.arg("test").arg("--locked").args(args).current_dir(root);
    c
}

fn store_itests(root: &Path, pg_port: u16, vanilla: bool) -> Command {
    let mut c = cargo_test(
        root,
        &["-p", "dash-store", "-p", "pulsus-dash", "--", "--ignored"],
    );
    c.env(
        "DASH_ITEST_PG_ADMIN_URL",
        format!("postgres://postgres@localhost:{pg_port}/postgres"),
    )
    .env("DASH_ITEST_EXPECT_VANILLA", if vanilla { "1" } else { "0" });
    c
}

/// Step 5: a scratch database migrated by the binary, then `cargo sqlx prepare --check`.
fn sqlx_check(root: &Path, stack: &Stack, violations: &mut Vec<Violation>) -> R<bool> {
    createdb(root, stack, &PROFILE, "sqlx_check")?;
    let bin = build_binary(root)?;
    let cfg_dir = root.join("target/itest");
    std::fs::create_dir_all(&cfg_dir).map_err(XtaskError::io(&cfg_dir))?;
    let cfg = cfg_dir.join("migrate.yaml");
    let yaml = format!(
        "allow_inline_secrets: true\npostgres:\n  url_ref: \"{}\"\n  owner_url_ref: \"{}\"\n",
        stack.pg_url("pulsus_app", "sqlx_check"),
        stack.pg_url("pulsus_owner", "sqlx_check"),
    );
    std::fs::write(&cfg, yaml).map_err(XtaskError::io(&cfg))?;
    if !step(
        "sqlx-check migrate",
        Command::new(&bin)
            .arg("migrate")
            .arg("--config")
            .arg(&cfg)
            .current_dir(root),
    ) {
        return Ok(false);
    }
    let prepared = step(
        "sqlx-check prepare",
        cargo_sqlx(root)
            .args(["sqlx", "prepare", "--workspace", "--check"])
            .env("DATABASE_URL", stack.pg_url("pulsus_owner", "sqlx_check"))
            .env("SQLX_OFFLINE", "false"),
    );
    if !prepared {
        violations.push(Violation {
            rule: Rule::SqlxCacheStale,
            path: PathBuf::from(".sqlx"),
            line: None,
            message: "the .sqlx offline cache does not match the queries; run `cargo xtask dev sqlx-prepare` and commit .sqlx/".into(),
        });
    }
    Ok(prepared)
}

/// Runs the gate; returns (violations, every step passed).
pub fn run(root: &Path) -> R<(Vec<Violation>, bool)> {
    let stack = Stack::itest(root);
    let mut violations = Vec::new();
    let up = stack.render(root).and_then(|()| {
        crate::tools::run(
            stack
                .compose(root)
                .args(PROFILE)
                .args(["up", "-d", "--wait", "--build"]),
        )
    });
    let up = up.and_then(|()| stack.wait_for_idp(IDP_WAIT));
    let passed = match up {
        Err(e) => {
            println!("itest: the stack did not start: {e}");
            false
        }
        Ok(()) => {
            let mut ok = step(
                "rls-isolation (postgres 16)",
                &mut store_itests(root, stack.pg_port, false),
            );
            ok &= step(
                "no-extensions (vanilla postgres 15)",
                &mut store_itests(root, stack.pg15_port, true),
            );
            ok &= step(
                "dev-stack idp",
                cargo_test(
                    root,
                    &["-p", "xtask", "--test", "dev_stack", "--", "--ignored"],
                )
                .env("DASH_ITEST_IDP_ISSUER", stack.issuer()),
            );
            ok &= match sqlx_check(root, &stack, &mut violations) {
                Ok(b) => b,
                Err(e) => {
                    println!("itest sqlx-check: {e}");
                    false
                }
            };
            ok
        }
    };
    let down = step(
        "down",
        stack.compose(root).args(PROFILE).args(["down", "-v"]),
    );
    Ok((violations, passed && down))
}
