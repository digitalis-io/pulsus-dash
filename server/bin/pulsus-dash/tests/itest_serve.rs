#![allow(clippy::unwrap_used, clippy::expect_used)]
//! `pulsus-dash` against real Postgres (T06-026, T19-006, T11-015, §4.1). Run by
//! `cargo xtask ci itest`; Postgres is reached through a stoppable TCP proxy.

mod support;

use std::time::{Duration, Instant};

use dash_store::testing::{ADMIN_URL_ENV, TestDb};
use support::{Proxy, Running, free_port, header, http_get, valid_yaml, write};

const URL: Option<&str> = Some("http://pulsusdb.invalid:9");

/// `host:port` of the itest Postgres.
fn pg_target() -> String {
    let admin = url::Url::parse(&std::env::var(ADMIN_URL_ENV).unwrap()).unwrap();
    format!(
        "{}:{}",
        admin.host_str().unwrap(),
        admin.port().unwrap_or(5432)
    )
}

struct Stack {
    dir: tempfile::TempDir,
    db: TestDb,
    proxy: Proxy,
}

impl Stack {
    async fn new(migrate: bool) -> Stack {
        let db = TestDb::create().await.unwrap();
        if migrate {
            db.migrate().await.unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("assets")).unwrap();
        std::fs::write(dir.path().join("assets/index.html"), "<p>x</p>").unwrap();
        let proxy = Proxy::new(free_port(), &pg_target());
        Stack { dir, db, proxy }
    }

    /// `role` URL of the test database through the proxy.
    fn url_via_proxy(&self, role: &str) -> String {
        let mut u = url::Url::parse(&self.db.url_as(role)).unwrap();
        u.set_host(Some("127.0.0.1")).unwrap();
        u.set_port(Some(self.proxy.port)).unwrap();
        u.to_string()
    }

    fn config(&self) -> String {
        let text = valid_yaml(
            &self.dir.path().join("assets"),
            &self.url_via_proxy("pulsus_app"),
            URL,
            "",
            "",
        );
        write(self.dir.path(), "cfg.yaml", &text)
            .display()
            .to_string()
    }

    fn migrate_config(&self) -> String {
        let text = format!(
            "allow_inline_secrets: true\npostgres:\n  url_ref: \"{}\"\n  owner_url_ref: \"{}\"\n",
            self.db.url_as("pulsus_app"),
            self.db.url_as("pulsus_owner")
        );
        write(self.dir.path(), "migrate.yaml", &text)
            .display()
            .to_string()
    }

    fn serve(&self) -> (Running, u16) {
        let r = Running::spawn(&["--config", &self.config()], &[]);
        let port = r.listening_port(Duration::from_secs(10));
        assert!(port.is_some(), "{}", r.output());
        (r, port.unwrap())
    }

    async fn finish(mut self) {
        self.proxy.stop();
        self.db.drop().await.unwrap();
    }
}

fn status(port: u16, path: &str) -> Option<u16> {
    http_get(port, path).map(|r| r.0)
}

/// Polls `GET path` until it answers `want` or `within` elapses.
fn wait_status(port: u16, path: &str, want: u16, within: Duration) -> bool {
    let end = Instant::now() + within;
    while Instant::now() < end {
        if status(port, path) == Some(want) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    false
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn serve_ready_with_pulsusdb_unreachable() {
    let mut s = Stack::new(true).await;
    s.proxy.start();
    let (r, port) = s.serve();
    assert!(
        wait_status(port, "/startupz", 200, Duration::from_secs(20)),
        "{}",
        r.output()
    );
    let (code, headers, body) = http_get(port, "/readyz").unwrap();
    assert_eq!(code, 200, "{body}");
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v, serde_json::json!({"status": "ready", "schema_level": 1}));
    assert_eq!(header(&headers, "cache-control"), Some("no-store"));
    drop(r);
    s.finish().await;
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn serve_unready_when_postgres_stops() {
    let mut s = Stack::new(true).await;
    s.proxy.start();
    let (r, port) = s.serve();
    assert!(
        wait_status(port, "/readyz", 200, Duration::from_secs(20)),
        "{}",
        r.output()
    );
    s.proxy.stop();
    let end = Instant::now() + Duration::from_secs(3);
    let mut seen = None;
    while Instant::now() < end {
        let resp = http_get(port, "/readyz").unwrap();
        if resp.0 == 503 {
            seen = Some(resp);
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    let (_, headers, body) = seen.unwrap_or_else(|| panic!("still ready: {}", r.output()));
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["error"]["hint"]["check"], "postgres", "{body}");
    assert_eq!(header(&headers, "cache-control"), Some("no-store"));
    assert_eq!(status(port, "/healthz"), Some(200));
    s.proxy.start();
    assert!(
        wait_status(port, "/readyz", 200, Duration::from_secs(5)),
        "{}",
        r.output()
    );
    drop(r);
    s.finish().await;
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn serve_waits_for_postgres_at_startup() {
    let mut s = Stack::new(true).await;
    let (r, port) = s.serve();
    assert_eq!(status(port, "/startupz"), Some(503));
    assert_eq!(status(port, "/"), Some(200));
    std::thread::sleep(Duration::from_secs(3));
    assert_eq!(status(port, "/startupz"), Some(503));
    s.proxy.start();
    assert!(
        wait_status(port, "/startupz", 200, Duration::from_secs(10)),
        "{}",
        r.output()
    );
    assert!(
        r.output().contains("waiting for postgres"),
        "{}",
        r.output()
    );
    drop(r);
    s.finish().await;
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn serve_refuses_unmigrated_schema() {
    let mut s = Stack::new(false).await;
    s.proxy.start();
    let (mut r, _) = s.serve();
    let st = r.wait_exit(Duration::from_secs(10));
    assert_eq!(st.and_then(|s| s.code()), Some(3), "{}", r.output());
    assert!(r.output().contains("schema not migrated"), "{}", r.output());
    s.finish().await;
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn serve_seeds_org_on_first_run() {
    let mut s = Stack::new(true).await;
    s.proxy.start();
    for run in 0..2 {
        let (mut r, port) = s.serve();
        assert!(
            wait_status(port, "/startupz", 200, Duration::from_secs(20)),
            "run {run}: {}",
            r.output()
        );
        r.terminate();
        let st = r.wait_exit(Duration::from_secs(35));
        assert_eq!(st.and_then(|s| s.code()), Some(0), "{}", r.output());
        assert_eq!(
            s.db.owner_i64("SELECT count(*) FROM orgs WHERE slug = 'default'")
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            s.db.owner_i64("SELECT count(*) FROM tenant_bindings")
                .await
                .unwrap(),
            1
        );
    }
    s.finish().await;
}

#[tokio::test]
#[ignore = "itest: run by cargo xtask ci itest"]
async fn migrate_subcommand() {
    let s = Stack::new(false).await;
    let cfg = s.migrate_config();
    let mut r = Running::spawn(&["migrate", "--config", &cfg], &[]);
    let st = r.wait_exit(Duration::from_secs(30));
    assert_eq!(st.and_then(|s| s.code()), Some(0), "{}", r.output());
    assert_eq!(
        s.db.owner_i64("SELECT level FROM pulsus_schema_level")
            .await
            .unwrap(),
        1
    );
    s.db.owner_exec("UPDATE pulsus_schema_level SET level = 3")
        .await
        .unwrap();
    let mut r = Running::spawn(&["migrate", "--config", &cfg], &[]);
    let st = r.wait_exit(Duration::from_secs(30));
    assert_eq!(st.and_then(|s| s.code()), Some(3), "{}", r.output());
    s.finish().await;
}
