//! Shared helpers of the binary's integration tests: a blocking HTTP GET, a scripted raw HTTP
//! server, a stoppable TCP proxy and a spawned `pulsus-dash` with captured output.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const BIN: &str = env!("CARGO_BIN_EXE_pulsus-dash");

/// Status, lower-cased headers and body of a response.
pub type HttpResponse = (u16, Vec<(String, String)>, String);

/// `GET path` on `localhost:port`, or `None` if the connection fails.
pub fn http_get(port: u16, path: &str) -> Option<HttpResponse> {
    let mut s =
        TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n\r\n"
    )
    .ok()?;
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).ok()?;
    let text = String::from_utf8_lossy(&raw).to_string();
    let (head, body) = text.split_once("\r\n\r\n")?;
    let mut lines = head.lines();
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let headers = lines
        .filter_map(|l| l.split_once(':'))
        .map(|(k, v)| (k.trim().to_ascii_lowercase(), v.trim().to_string()))
        .collect();
    Some((status, headers, body.to_string()))
}

pub fn header<'a>(h: &'a [(String, String)], name: &str) -> Option<&'a str> {
    h.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str())
}

/// A free loopback port (bound, then released).
pub fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// What the scripted server does with each connection.
#[derive(Clone, Debug)]
pub enum Script {
    /// Reads the request head, writes these bytes, closes.
    Respond(&'static str),
    /// Accepts and never answers.
    Hang,
}

/// A raw HTTP server on `127.0.0.1` running `script` for every connection.
pub fn scripted_server(script: Script) -> u16 {
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    std::thread::spawn(move || {
        let mut held = Vec::new();
        for s in l.incoming() {
            let Ok(mut s) = s else { continue };
            match &script {
                Script::Respond(resp) => {
                    let mut r = BufReader::new(s.try_clone().unwrap());
                    let mut line = String::new();
                    while r.read_line(&mut line).is_ok_and(|n| n > 0) {
                        if line == "\r\n" {
                            break;
                        }
                        line.clear();
                    }
                    let _ = s.write_all(resp.as_bytes());
                    let _ = s.shutdown(Shutdown::Both);
                }
                Script::Hang => held.push(s),
            }
        }
    });
    port
}

/// A TCP proxy `127.0.0.1:port → target` that can be stopped (listener and every open socket)
/// and restarted on the same port.
pub struct Proxy {
    pub port: u16,
    target: String,
    stop: Arc<AtomicBool>,
    sockets: Arc<Mutex<Vec<TcpStream>>>,
}

impl Proxy {
    pub fn new(port: u16, target: &str) -> Proxy {
        Proxy {
            port,
            target: target.to_string(),
            stop: Arc::new(AtomicBool::new(true)),
            sockets: Arc::new(Mutex::new(Vec::new())),
        }
    }

    pub fn start(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        let l = loop {
            match TcpListener::bind(("127.0.0.1", self.port)) {
                Ok(l) => break l,
                Err(e) if Instant::now() < deadline => {
                    let _ = e;
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(e) => panic!("proxy bind {}: {e}", self.port),
            }
        };
        l.set_nonblocking(true).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        self.stop = stop.clone();
        let sockets = self.sockets.clone();
        let target = self.target.clone();
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                match l.accept() {
                    Ok((client, _)) => {
                        client.set_nonblocking(false).unwrap();
                        let Ok(server) = TcpStream::connect(&target) else {
                            continue;
                        };
                        let mut held = sockets.lock().unwrap();
                        held.push(client.try_clone().unwrap());
                        held.push(server.try_clone().unwrap());
                        drop(held);
                        pipe(client.try_clone().unwrap(), server.try_clone().unwrap());
                        pipe(server, client);
                    }
                    Err(_) => std::thread::sleep(Duration::from_millis(20)),
                }
            }
        });
    }

    /// Closes the listener and every proxied socket.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        for s in self.sockets.lock().unwrap().drain(..) {
            let _ = s.shutdown(Shutdown::Both);
        }
        // Let the accept loop observe the flag and drop the listener.
        std::thread::sleep(Duration::from_millis(100));
    }
}

impl Drop for Proxy {
    fn drop(&mut self) {
        self.stop();
    }
}

fn pipe(mut from: TcpStream, mut to: TcpStream) {
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut from, &mut to);
        let _ = to.shutdown(Shutdown::Write);
    });
}

/// A spawned `pulsus-dash` with stdout and stderr captured.
pub struct Running {
    pub child: Child,
    out: Arc<Mutex<String>>,
}

impl Running {
    /// Runs `pulsus-dash args` with a cleared environment plus `env`.
    pub fn spawn(args: &[&str], env: &[(&str, &str)]) -> Running {
        let mut cmd = Command::new(BIN);
        cmd.args(args)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (k, v) in env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn().unwrap();
        let out = Arc::new(Mutex::new(String::new()));
        for stream in [
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            Box::new(child.stderr.take().unwrap()),
        ] {
            let out = out.clone();
            std::thread::spawn(move || {
                let mut r = BufReader::new(stream);
                let mut line = String::new();
                while r.read_line(&mut line).is_ok_and(|n| n > 0) {
                    out.lock().unwrap().push_str(&line);
                    line.clear();
                }
            });
        }
        Running { child, out }
    }

    /// Everything printed so far (stdout and stderr interleaved by line).
    pub fn output(&self) -> String {
        self.out.lock().unwrap().clone()
    }

    /// Polls `f(output)` until it is true or `within` elapses.
    pub fn wait_for(&self, within: Duration, f: impl Fn(&str) -> bool) -> bool {
        let end = Instant::now() + within;
        while Instant::now() < end {
            if f(&self.output()) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        f(&self.output())
    }

    /// The port of the `pulsus-dash listening on http://<addr>` line, once logged.
    pub fn listening_port(&self, within: Duration) -> Option<u16> {
        let marker = "pulsus-dash listening on http://";
        self.wait_for(within, |o| o.contains(marker));
        let o = self.output();
        let rest = &o[o.find(marker)? + marker.len()..];
        let addr: String = rest
            .chars()
            .take_while(|c| !c.is_whitespace() && *c != '"')
            .collect();
        addr.rsplit_once(':')?.1.parse().ok()
    }

    /// Waits for exit up to `within`.
    pub fn wait_exit(&mut self, within: Duration) -> Option<ExitStatus> {
        let end = Instant::now() + within;
        while Instant::now() < end {
            if let Some(s) = self.child.try_wait().unwrap() {
                // Let the reader threads drain.
                std::thread::sleep(Duration::from_millis(100));
                return Some(s);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        None
    }

    /// SIGTERM.
    pub fn terminate(&self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .status();
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Writes `text` to `dir/name` and returns the path.
pub fn write(dir: &Path, name: &str, text: &str) -> PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, text).unwrap();
    p
}

/// The plan §5 "valid YAML" with `assets.dir` = `assets`, plus `extra` top-level lines and
/// `seed` lines under the bootstrap entry.
pub fn valid_yaml(
    assets: &Path,
    pg_url: &str,
    url: Option<&str>,
    extra: &str,
    seed: &str,
) -> String {
    let url_line = url
        .map(|u| format!("    url: \"{u}\"\n"))
        .unwrap_or_default();
    format!(
        "listen: \"localhost:0\"\nallow_inline_secrets: true\npostgres:\n  url_ref: \"{pg_url}\"\n  connect_timeout_ms: 1000\nassets:\n  dir: \"{}\"\n{extra}datasources_bootstrap:\n  - slug: default\n{url_line}{seed}",
        assets.display()
    )
}
