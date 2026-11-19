//! `cargo xtask dev up|down|reset|sqlx-prepare` (plan §3.10, §4.4): the local compose stack
//! (Postgres 16, Dex) and the binary on top of it. See `docs/development/dev-stack.md`.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use crate::tools::run;
use crate::{R, XtaskError};

/// The compose file.
pub const COMPOSE_FILE: &str = "dev/compose.yaml";
/// The tracked dev configuration (no PulsusDB URL).
pub const DEV_CONFIG: &str = "dev/pulsus-dash.dev.yaml";
/// Untracked `KEY=VALUE` overrides (the PulsusDB URL).
pub const LOCAL_ENV: &str = "dev/local.env";
/// The Dex template.
pub const DEX_TEMPLATE: &str = "dev/dex.yaml.tmpl";
/// Default Postgres port of the dev stack (the dev YAML's URLs).
pub const DEV_PG_PORT: u16 = 55432;
/// How long Dex discovery is polled.
pub const IDP_WAIT: Duration = Duration::from_secs(60);

/// `dev/local.env` merged under `env`: `KEY=VALUE` lines, `#` comments and blanks ignored, one
/// pair of surrounding `"` stripped; variables already in `env` win. Returns `env` plus the new
/// pairs.
pub fn merge_local_env(text: &str, env: &[(String, String)]) -> Vec<(String, String)> {
    let mut out = env.to_vec();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim();
        let v = v.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|x| x.strip_suffix('"'))
            .unwrap_or(v);
        if !k.is_empty() && !out.iter().any(|(e, _)| e == k) {
            out.push((k.to_string(), v.to_string()));
        }
    }
    out
}

/// Renders `dev/dex.yaml.tmpl` for `idp_port` with a bcrypt (cost 10) hash of `password`.
pub fn render_dex(template: &str, idp_port: u16, password: &str) -> R<String> {
    let hash = bcrypt::hash(password, 10).map_err(|e| XtaskError::Tool {
        command: "bcrypt".into(),
        detail: e.to_string(),
    })?;
    let out = template
        .replace("@@IDP_PORT@@", &idp_port.to_string())
        .replace("@@DEV_USER_BCRYPT@@", &hash);
    if out.contains("@@") {
        return Err(XtaskError::config(DEX_TEMPLATE, "unknown @@placeholder@@"));
    }
    Ok(out)
}

/// A random 24-character alphanumeric password (OS randomness, unbiased).
pub fn random_password() -> R<String> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut out = String::new();
    while out.len() < 24 {
        let mut buf = [0u8; 32];
        getrandom::fill(&mut buf).map_err(|e| XtaskError::Tool {
            command: "getrandom".into(),
            detail: e.to_string(),
        })?;
        for b in buf {
            // 248 = 4 × 62: reject the tail to keep the choice uniform.
            if b < 248 && out.len() < 24 {
                out.push(char::from(ALPHABET[usize::from(b % 62)]));
            }
        }
    }
    Ok(out)
}

fn env_get<'a>(env: &'a [(String, String)], k: &str) -> Option<&'a str> {
    env.iter().find(|(x, _)| x == k).map(|(_, v)| v.as_str())
}

fn port_from(env: &[(String, String)], k: &str, default: u16) -> R<u16> {
    match env_get(env, k) {
        None | Some("") => Ok(default),
        Some(v) => v
            .parse()
            .map_err(|_| XtaskError::Usage(format!("{k} must be a port number"))),
    }
}

/// One compose project: name, published ports and the rendered Dex config.
#[derive(Debug, Clone)]
pub struct Stack {
    pub project: String,
    pub pg_port: u16,
    pub pg15_port: u16,
    pub idp_port: u16,
    /// `target/dev/<project>/` (absolute).
    pub dir: PathBuf,
}

impl Stack {
    /// The dev stack: `$DASH_DEV_PROJECT` and `$DASH_{PG,PG15,IDP}_PORT` with their defaults.
    pub fn dev(root: &Path, env: &[(String, String)]) -> R<Stack> {
        let project = env_get(env, "DASH_DEV_PROJECT")
            .filter(|p| !p.is_empty())
            .unwrap_or("pulsus-dash-dev")
            .to_string();
        Ok(Stack {
            dir: root.join("target/dev").join(&project),
            project,
            pg_port: port_from(env, "DASH_PG_PORT", DEV_PG_PORT)?,
            pg15_port: port_from(env, "DASH_PG15_PORT", 55433)?,
            idp_port: port_from(env, "DASH_IDP_PORT", 5556)?,
        })
    }

    /// The itest stack (plan §4.5).
    pub fn itest(root: &Path) -> Stack {
        Stack {
            project: "pulsus-dash-itest".into(),
            pg_port: 56432,
            pg15_port: 56433,
            idp_port: 6556,
            dir: root.join("target/dev/pulsus-dash-itest"),
        }
    }

    pub fn dex_config(&self) -> PathBuf {
        self.dir.join("dex.yaml")
    }

    pub fn issuer(&self) -> String {
        format!("http://localhost:{}/dex", self.idp_port)
    }

    /// `docker compose -p <project> -f dev/compose.yaml` with the stack environment.
    pub fn compose(&self, root: &Path) -> Command {
        let mut c = Command::new("docker");
        c.args(["compose", "-p", &self.project, "-f", COMPOSE_FILE])
            .current_dir(root)
            .env("DASH_PG_PORT", self.pg_port.to_string())
            .env("DASH_PG15_PORT", self.pg15_port.to_string())
            .env("DASH_IDP_PORT", self.idp_port.to_string())
            .env("DASH_DEX_CONFIG", self.dex_config());
        c
    }

    /// Writes `dex.yaml` from the template and a password kept in `dev-user.txt` (created once).
    pub fn render(&self, root: &Path) -> R<()> {
        std::fs::create_dir_all(&self.dir).map_err(XtaskError::io(&self.dir))?;
        let pw_file = self.dir.join("dev-user.txt");
        let password = match std::fs::read_to_string(&pw_file) {
            Ok(p) if !p.trim().is_empty() => p.trim().to_string(),
            _ => {
                let p = random_password()?;
                std::fs::write(&pw_file, format!("{p}\n")).map_err(XtaskError::io(&pw_file))?;
                p
            }
        };
        let tmpl = std::fs::read_to_string(root.join(DEX_TEMPLATE))
            .map_err(XtaskError::io(root.join(DEX_TEMPLATE)))?;
        let out = render_dex(&tmpl, self.idp_port, &password)?;
        let dex = self.dex_config();
        std::fs::write(&dex, out).map_err(XtaskError::io(&dex))
    }

    /// Polls the IdP's OIDC discovery document until it answers 200.
    pub fn wait_for_idp(&self, within: Duration) -> R<()> {
        let end = Instant::now() + within;
        while Instant::now() < end {
            if discovery_status(self.idp_port) == Some(200) {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        Err(XtaskError::Tool {
            command: format!("GET {}/.well-known/openid-configuration", self.issuer()),
            detail: format!("no 200 within {} s", within.as_secs()),
        })
    }

    /// Render, `compose up -d --wait <services>`, wait for Dex.
    pub fn up(&self, root: &Path, extra: &[&str], services: &[&str]) -> R<()> {
        self.render(root)?;
        run(self
            .compose(root)
            .args(extra)
            .args(["up", "-d", "--wait"])
            .args(services))?;
        self.wait_for_idp(IDP_WAIT)
    }

    /// The Postgres URL of `role` on database `db` of this stack.
    pub fn pg_url(&self, role: &str, db: &str) -> String {
        format!("postgres://{role}@localhost:{}/{db}", self.pg_port)
    }
}

fn discovery_status(port: u16) -> Option<u16> {
    let mut s =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(1)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    write!(
        s,
        "GET /dex/.well-known/openid-configuration HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut head = [0u8; 16];
    s.read_exact(&mut head).ok()?;
    String::from_utf8_lossy(&head)
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// The process environment (UTF-8 pairs) with `dev/local.env` merged under it.
pub fn environment(root: &Path) -> R<Vec<(String, String)>> {
    let env: Vec<(String, String)> = std::env::vars_os()
        .filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)))
        .collect();
    let path = root.join(LOCAL_ENV);
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(merge_local_env(&text, &env)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(env),
        Err(e) => Err(XtaskError::Io { path, source: e }),
    }
}

/// `cargo build --locked -p pulsus-dash`; returns `target/debug/pulsus-dash`.
pub fn build_binary(root: &Path) -> R<PathBuf> {
    run(Command::new("cargo")
        .args(["build", "--locked", "-p", "pulsus-dash"])
        .current_dir(root))?;
    Ok(root.join("target/debug/pulsus-dash"))
}

/// The dev YAML's Postgres URLs pointed at `stack`'s port when it is not the default.
fn pg_overrides(stack: &Stack) -> Vec<(String, String)> {
    if stack.pg_port == DEV_PG_PORT {
        return Vec::new();
    }
    vec![
        (
            "PULSUS_DASH_POSTGRES__URL_REF".into(),
            stack.pg_url("pulsus_app", "pulsus"),
        ),
        (
            "PULSUS_DASH_POSTGRES__OWNER_URL_REF".into(),
            stack.pg_url("pulsus_owner", "pulsus"),
        ),
    ]
}

#[derive(Debug, Default)]
struct UpArgs {
    port: Option<u16>,
    assets: Option<PathBuf>,
}

fn up_args(root: &Path, args: &[String]) -> R<UpArgs> {
    let usage = || XtaskError::Usage("dev up|reset [--port N] [--assets DIR]".into());
    let mut a = UpArgs::default();
    let mut it = args.iter();
    while let Some(x) = it.next() {
        match x.as_str() {
            "--port" => {
                a.port = Some(it.next().and_then(|p| p.parse().ok()).ok_or_else(usage)?);
            }
            "--assets" => a.assets = Some(root.join(it.next().ok_or_else(usage)?)),
            _ => return Err(usage()),
        }
    }
    Ok(a)
}

/// `dev up`: stack, assets, migrate, then exec the binary (Unix).
fn up(root: &Path, args: &[String]) -> R<u8> {
    let a = up_args(root, args)?;
    let env = environment(root)?;
    let stack = Stack::dev(root, &env)?;
    stack.up(root, &[], &["postgres", "idp"])?;
    let assets = match a.assets {
        Some(dir) => dir,
        None => {
            crate::tools::install(root, &crate::tools::load(root)?)?;
            crate::r#gen::generate(root, &crate::r#gen::GenOptions::dev(root))?;
            root.join("web")
        }
    };
    let bin = build_binary(root)?;
    let mut overrides = pg_overrides(&stack);
    run(Command::new(&bin)
        .args(["migrate", "--config", DEV_CONFIG])
        .current_dir(root)
        .envs(env.iter().cloned())
        .envs(overrides.iter().cloned()))?;
    let port = a.port.unwrap_or(8080);
    overrides.extend([
        (
            "PULSUS_DASH_LISTEN".to_string(),
            format!("localhost:{port}"),
        ),
        (
            "PULSUS_DASH_PUBLIC_URL".to_string(),
            format!("http://localhost:{port}"),
        ),
        (
            "PULSUS_DASH_ASSETS__DIR".to_string(),
            assets.display().to_string(),
        ),
    ]);
    let mut serve = Command::new(&bin);
    serve
        .args(["--role", "all", "--config", DEV_CONFIG])
        .current_dir(root)
        .envs(env.iter().cloned())
        .envs(overrides);
    println!(
        "$ {} --role all --config {DEV_CONFIG}",
        crate::rel_str(&crate::relative(root, &bin))
    );
    exec(serve)
}

#[cfg(unix)]
fn exec(mut cmd: Command) -> R<u8> {
    use std::os::unix::process::CommandExt;
    let e = cmd.exec();
    Err(XtaskError::Tool {
        command: crate::tools::display(&cmd),
        detail: e.to_string(),
    })
}

#[cfg(not(unix))]
fn exec(_cmd: Command) -> R<u8> {
    Err(XtaskError::Usage(
        "dev up execs the server and needs a Unix host".into(),
    ))
}

fn remove_dir(dir: &Path) -> R<()> {
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(XtaskError::Io {
            path: dir.to_path_buf(),
            source: e,
        }),
    }
}

/// `dev sqlx-prepare`: refresh the committed `.sqlx` offline cache from a scratch database.
fn sqlx_prepare(root: &Path) -> R<u8> {
    let env = environment(root)?;
    let stack = Stack::dev(root, &env)?;
    stack.up(root, &[], &["postgres", "idp"])?;
    createdb(root, &stack, &[], "sqlx_prepare")?;
    let owner = stack.pg_url("pulsus_owner", "sqlx_prepare");
    // Migrated with sqlx-cli: the binary itself cannot build offline while the cache is stale.
    run(cargo_sqlx(root)
        .args([
            "sqlx",
            "migrate",
            "run",
            "--source",
            crate::migrations::MIGRATIONS_DIR,
        ])
        .env("DATABASE_URL", &owner))?;
    run(cargo_sqlx(root)
        .args(["sqlx", "prepare", "--workspace"])
        .env("DATABASE_URL", &owner)
        .env("SQLX_OFFLINE", "false"))?;
    Ok(0)
}

/// `cargo` with `target/tools/bin` first on `PATH` (sqlx-cli must run as `cargo sqlx`).
pub fn cargo_sqlx(root: &Path) -> Command {
    let mut c = Command::new("cargo");
    let tools = root.join(crate::tools::TOOLS_DIR).join("bin");
    let path = std::env::var_os("PATH").unwrap_or_default();
    let mut dirs = vec![tools];
    dirs.extend(std::env::split_paths(&path));
    if let Ok(joined) = std::env::join_paths(dirs) {
        c.env("PATH", joined);
    }
    c.current_dir(root);
    c
}

/// `compose exec -T postgres createdb -U postgres -O pulsus_owner <db>`; an existing database is
/// fine.
pub fn createdb(root: &Path, stack: &Stack, extra: &[&str], db: &str) -> R<()> {
    let out = stack
        .compose(root)
        .args(extra)
        .args([
            "exec",
            "-T",
            "postgres",
            "createdb",
            "-U",
            "postgres",
            "-O",
            "pulsus_owner",
            db,
        ])
        .output()
        .map_err(|e| XtaskError::Tool {
            command: "docker compose exec postgres createdb".into(),
            detail: e.to_string(),
        })?;
    let stderr = String::from_utf8_lossy(&out.stderr);
    if out.status.success() || stderr.contains("already exists") {
        Ok(())
    } else {
        Err(XtaskError::Tool {
            command: format!("createdb {db}"),
            detail: stderr.trim().to_string(),
        })
    }
}

/// `cargo xtask dev <args>`.
pub fn dev(root: &Path, args: &[String]) -> R<u8> {
    let cmd = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or(&[]);
    match cmd {
        Some("up") => up(root, rest),
        Some("down") if rest.is_empty() => {
            let stack = Stack::dev(root, &environment(root)?)?;
            run(stack.compose(root).arg("down"))?;
            remove_dir(&stack.dir)?;
            Ok(0)
        }
        Some("reset") => {
            let stack = Stack::dev(root, &environment(root)?)?;
            run(stack.compose(root).args(["down", "-v"]))?;
            remove_dir(&stack.dir)?;
            up(root, rest)
        }
        Some("sqlx-prepare") if rest.is_empty() => sqlx_prepare(root),
        _ => Err(XtaskError::Usage(
            "dev up [--port N] [--assets DIR] | down | reset [--port N] [--assets DIR] | sqlx-prepare"
                .into(),
        )),
    }
}
