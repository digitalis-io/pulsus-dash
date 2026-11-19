//! `cargo xtask serve`: a single-threaded static dev server with the headers the runtime needs
//! (T03 §5.7, T03-022; plan §4.9). `--no-isolation` drops COOP and COEP to exercise ST mode.

use std::path::{Path, PathBuf};

use crate::{R, XtaskError};

/// Dev server options.
#[derive(Debug, Clone)]
pub struct ServeOptions {
    pub root: PathBuf,
    pub port: u16,
    pub isolation: bool,
}

const CSP: &str =
    "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self'; font-src 'self'";

fn content_type(path: &str) -> &'static str {
    match Path::new(path).extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("css") => "text/css",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

/// The response headers for `path`: COOP/COEP (when `isolation`), CORP, CSP, `no-cache`,
/// `nosniff` and the content type.
pub fn headers(path: &str, isolation: bool) -> Vec<(&'static str, String)> {
    let mut h = Vec::new();
    if isolation {
        h.push(("Cross-Origin-Opener-Policy", "same-origin".to_string()));
        h.push(("Cross-Origin-Embedder-Policy", "require-corp".to_string()));
    }
    h.push(("Cross-Origin-Resource-Policy", "same-origin".to_string()));
    h.push(("Content-Security-Policy", CSP.to_string()));
    h.push(("Cache-Control", "no-cache".to_string()));
    h.push(("X-Content-Type-Options", "nosniff".to_string()));
    h.push(("Content-Type", content_type(path).to_string()));
    h
}

/// Maps a request URL to a file under `root`: `/` → `index.html`; `%`, `\`, a `..` segment, a
/// directory or a missing file → `None` (404).
fn resolve(root: &Path, url: &str) -> Option<PathBuf> {
    let path = url.split(['?', '#']).next().unwrap_or("");
    if path.contains('%') || path.contains('\\') || !path.starts_with('/') {
        return None;
    }
    let mut out = root.to_path_buf();
    let mut any = false;
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." || seg == "." {
            return None;
        }
        out.push(seg);
        any = true;
    }
    if !any {
        out.push("index.html");
    }
    out.is_file().then_some(out)
}

fn respond(rq: tiny_http::Request, root: &Path, isolation: bool) -> std::io::Result<()> {
    use tiny_http::{Header, Method, Response};
    if !matches!(rq.method(), Method::Get | Method::Head) {
        return rq.respond(Response::from_string("method not allowed").with_status_code(405));
    }
    let Some(file) = resolve(root, rq.url()) else {
        return rq.respond(Response::from_string("not found").with_status_code(404));
    };
    let body = match std::fs::read(&file) {
        Ok(b) => b,
        Err(_) => return rq.respond(Response::from_string("not found").with_status_code(404)),
    };
    let mut resp = Response::from_data(body);
    for (k, v) in headers(&file.to_string_lossy(), isolation) {
        if let Ok(h) = Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            resp.add_header(h);
        }
    }
    rq.respond(resp)
}

/// Serves `o.root` on `localhost:o.port` (0 = any free port, reported on `ready`) until the
/// process stops; one request at a time.
pub fn serve(o: &ServeOptions, ready: Option<std::sync::mpsc::Sender<u16>>) -> R<()> {
    let server = tiny_http::Server::http(("localhost", o.port)).map_err(|e| XtaskError::Tool {
        command: format!("serve on localhost:{}", o.port),
        detail: e.to_string(),
    })?;
    if let (Some(tx), Some(addr)) = (ready, server.server_addr().to_ip()) {
        // The receiver may have given up waiting; serving continues regardless.
        let _ = tx.send(addr.port());
    }
    for rq in server.incoming_requests() {
        if let Err(e) = respond(rq, &o.root, o.isolation) {
            eprintln!("serve: {e}");
        }
    }
    Ok(())
}
